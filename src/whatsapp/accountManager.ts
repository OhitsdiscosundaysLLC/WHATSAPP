import { randomUUID } from 'crypto';
import path from 'path';
import { AIService } from '../ai/aiService';
import { OpenAIProvider } from '../ai/openaiProvider';
import { config } from '../config/config';
import { AccountSettingsRepository } from '../db/accountSettingsRepository';
import { AdminsRepository } from '../db/adminsRepository';
import { AiUsageRepository } from '../db/aiUsageRepository';
import { AuditRepository } from '../db/auditRepository';
import { CallEventsRepository } from '../db/callEventsRepository';
import { ContactsRepository } from '../db/contactsRepository';
import { GroupsRepository } from '../db/groupsRepository';
import { IdentityMapRepository } from '../db/identityMapRepository';
import { MediaArchiveRepository } from '../db/mediaArchiveRepository';
import { MessagesRepository } from '../db/messagesRepository';
import { ModerationStateRepository } from '../db/moderationStateRepository';
import { NotificationCooldownRepository } from '../db/notificationCooldownRepository';
import { OwnerInboxRepository } from '../db/ownerInboxRepository';
import { RulesRepository } from '../db/rulesRepository';
import { RuleStateRepository } from '../db/ruleStateRepository';
import { getSupabaseClient } from '../db/supabaseClient';
import { DeterministicResponseClassifier } from '../rules/classifiers/responseClassifier';
import { RuleEngine } from '../rules/ruleEngine';
import { createChildLogger } from '../services/logger';
import { type AccountStore, JsonManifestAccountStore, SupabaseAccountStore } from './accountStore';
import { FileAuthStateProvider } from './auth/fileAuthStateProvider';
import { SupabaseAuthStateProvider } from './auth/supabaseAuthStateProvider';
import { resolveAuthStorageMode, type AuthStorageMode } from './authStorageMode';
import { handleCallEvent } from './calls/callHandler';
import { WhatsAppConnectionManager, type ConnectionManagerOptions } from './connectionManager';
import { EventPipeline } from './events/eventPipeline';
import { handleDiscoveredGroups } from './groups/groupDiscovery';
import type { PairingListener, PairingSnapshot, WhatsAppStatus } from './types';

const log = createChildLogger('whatsapp:accounts');

/** OWNER_WHATSAPP_NUMBERS, formatted as WhatsApp JIDs for NOTIFY_OWNER/call notifications. */
function ownerJids(): string[] {
  return config.authorization.ownerNumbers.map((number) => `${number}@s.whatsapp.net`);
}

export interface AccountSummary {
  id: string;
  label: string;
  createdAt: string;
  status: WhatsAppStatus;
}

interface AccountRecord {
  id: string;
  label: string;
  createdAt: string;
  manager: WhatsAppConnectionManager;
}

const MAX_LABEL_LENGTH = 60;

/**
 * Multi-account registry: one `WhatsAppConnectionManager` per WhatsApp
 * account. See docs/ARCHITECTURE.md for why Phase 2 (single implicit
 * account) was refactored into this registry, and docs/DECISIONS.md
 * ADR-010/ADR-011 for the Phase 3 storage model described here.
 *
 * Storage is pluggable and resolved once, lazily, via
 * `resolveAuthStorageMode()`:
 *  - Supabase configured (+ a valid WHATSAPP_AUTH_ENCRYPTION_KEY) →
 *    `SupabaseAccountStore` + `SupabaseAuthStateProvider` per account —
 *    durable across restarts/redeploys.
 *  - Otherwise → `JsonManifestAccountStore` + `FileAuthStateProvider` —
 *    local development only, resets with the filesystem.
 *
 * If Supabase is configured but the encryption key is missing/invalid,
 * this deliberately does NOT fall back to file storage — see
 * `authStorageMode.ts`'s doc comment. Instead `load()`/`createAccount()`
 * surface the error clearly (via `/health` and the dashboard's create
 * response) rather than silently running ephemeral, insecure storage
 * while claiming to be durable.
 */
export class AccountManager {
  private readonly authRootDir: string;
  private readonly accounts = new Map<string, AccountRecord>();
  private store: AccountStore | null = null;
  private storageMode: AuthStorageMode | null = null;
  private loadError: string | undefined;
  private loaded = false;

  constructor(authRootDir: string) {
    this.authRootDir = authRootDir;
  }

  /** Loads the account list and constructs (but does not start) each account's manager. */
  async load(): Promise<void> {
    if (this.loaded) return;
    this.loaded = true;

    try {
      this.storageMode = resolveAuthStorageMode();
      this.store =
        this.storageMode.kind === 'supabase'
          ? new SupabaseAccountStore(getSupabaseClient())
          : new JsonManifestAccountStore(this.authRootDir);

      const entries = await this.store.list();
      for (const entry of entries) {
        this.accounts.set(entry.id, {
          id: entry.id,
          label: entry.label,
          createdAt: entry.createdAt,
          manager: this.buildManager(entry.id),
        });
      }

      log.info(
        { accountCount: this.accounts.size, storageMode: this.storageMode.kind },
        'Loaded WhatsApp account registry',
      );
    } catch (err) {
      this.loadError = err instanceof Error ? err.message : String(err);
      log.fatal(
        { err },
        'WhatsApp account storage is misconfigured — no accounts will be loaded or created until this is fixed',
      );
    }
  }

  /** Starts (or resumes) every known account's connection. Call once at boot. */
  async startAll(): Promise<void> {
    await this.load();
    await Promise.allSettled(
      [...this.accounts.values()].map((account) =>
        account.manager
          .start()
          .catch((err: unknown) =>
            log.error({ err, accountId: account.id }, 'Failed to start account'),
          ),
      ),
    );
  }

  async shutdownAll(): Promise<void> {
    await Promise.allSettled(
      [...this.accounts.values()].map((account) => account.manager.shutdown()),
    );
  }

  listAccounts(): AccountSummary[] {
    return [...this.accounts.values()]
      .map((account) => toSummary(account))
      .sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  }

  async createAccount(rawLabel: string): Promise<AccountSummary> {
    await this.load();
    if (this.loadError || !this.store) {
      throw new Error(
        `WhatsApp account storage is misconfigured: ${this.loadError ?? 'not initialized'}`,
      );
    }

    const label = normalizeLabel(rawLabel, this.accounts.size + 1);
    const id = randomUUID();
    const createdAt = new Date().toISOString();
    const manager = this.buildManager(id);

    await this.store.create({ id, label, createdAt });
    this.accounts.set(id, { id, label, createdAt, manager });

    log.info({ accountId: id, label }, 'Created WhatsApp account');
    this.maybeStart(manager, id);

    return { id, label, createdAt, status: manager.getStatus() };
  }

  /** Re-attempts connection for an account that is e.g. logged_out or errored. */
  async reconnectAccount(id: string): Promise<AccountSummary | undefined> {
    const account = this.accounts.get(id);
    if (!account) return undefined;
    if (!config.whatsapp.enabled) {
      log.warn({ accountId: id }, 'Ignoring reconnect request: WHATSAPP_ENABLED=false');
      return toSummary(account);
    }
    await account.manager.start();
    return toSummary(account);
  }

  /** Starts an account's connection unless WhatsApp integration is globally disabled. */
  private maybeStart(manager: WhatsAppConnectionManager, accountId: string): void {
    if (!config.whatsapp.enabled) {
      log.warn({ accountId }, 'Not starting account: WHATSAPP_ENABLED=false');
      return;
    }
    void manager
      .start()
      .catch((err: unknown) => log.error({ err, accountId }, 'Failed to start account'));
  }

  /** Unlinks the device and clears credentials, but keeps the account slot for re-pairing. */
  async disconnectAccount(id: string): Promise<AccountSummary | undefined> {
    const account = this.accounts.get(id);
    if (!account) return undefined;
    await account.manager.requestLogout();
    return toSummary(account);
  }

  /** Fully removes the account: unlinks, clears all local state, deletes the slot. */
  async removeAccount(id: string): Promise<boolean> {
    const account = this.accounts.get(id);
    if (!account || !this.store) return false;

    await account.manager.requestLogout();
    await account.manager.shutdown();
    this.accounts.delete(id);
    await this.store.remove(id);

    log.info({ accountId: id }, 'Removed WhatsApp account');
    return true;
  }

  async requestPairingCode(id: string, phoneNumber: string): Promise<string | undefined> {
    const account = this.accounts.get(id);
    if (!account) return undefined;
    return account.manager.requestPairingCode(phoneNumber);
  }

  getPairingSnapshot(id: string): PairingSnapshot | undefined {
    return this.accounts.get(id)?.manager.getPairingSnapshot();
  }

  onAccountUpdate(id: string, listener: PairingListener): (() => void) | undefined {
    return this.accounts.get(id)?.manager.onUpdate(listener);
  }

  hasAccount(id: string): boolean {
    return this.accounts.has(id);
  }

  /**
   * Which storage backend is actually in effect, and whether it's
   * misconfigured — surfaced via `/health` (`authPersistence`). Call
   * `load()` (or any method that calls it) at least once first; before
   * that this reports `unknown`.
   */
  getStorageStatus(): { mode: 'file' | 'supabase' | 'unknown'; durable: boolean; error?: string } {
    if (this.loadError) {
      return { mode: 'unknown', durable: false, error: this.loadError };
    }
    if (!this.storageMode) {
      return { mode: 'unknown', durable: false };
    }
    return { mode: this.storageMode.kind, durable: this.storageMode.kind === 'supabase' };
  }

  /**
   * A single representative status for `/health` and `/ready`, which were
   * designed around one WhatsApp connection (Phase 2) and intentionally
   * were not redesigned around a list in Phase 2B — see docs/ARCHITECTURE.md.
   * Prefers a connected account; falls back to the first known account;
   * reports `disabled` if there are none yet.
   */
  getAggregateStatus(): WhatsAppStatus {
    const all = [...this.accounts.values()];
    if (all.length === 0) {
      return {
        state: 'disabled',
        detail: this.loadError
          ? `WhatsApp account storage is misconfigured: ${this.loadError}`
          : 'No WhatsApp accounts configured yet — add one from the dashboard.',
        reconnectAttempt: 0,
        updatedAt: new Date().toISOString(),
      };
    }

    const connected = all.find((a) => a.manager.getStatus().state === 'connected');
    return (connected ?? all[0]!).manager.getStatus();
  }

  private buildManager(accountId: string): WhatsAppConnectionManager {
    const authProvider =
      this.storageMode?.kind === 'supabase'
        ? new SupabaseAuthStateProvider({
            accountId,
            supabase: getSupabaseClient(),
            encryptionKey: this.storageMode.encryptionKey,
            logger: createChildLogger(`whatsapp:account:${accountId}:auth`),
          })
        : new FileAuthStateProvider(path.join(this.authRootDir, accountId));

    // `manager` is referenced (not called) inside `sender` before it's
    // assigned below — safe, since sendTextMessage is only ever invoked
    // later, after construction completes and the account actually
    // connects. See docs/DECISIONS.md ADR-012.
    // Must be `let`, declared before the closures below that capture it —
    // `const` can't express "declared now, assigned once, later."
    // eslint-disable-next-line prefer-const
    let manager: WhatsAppConnectionManager;

    let onMessage: ConnectionManagerOptions['onMessage'];
    let onGroupsDiscovered: ConnectionManagerOptions['onGroupsDiscovered'];
    let onCall: ConnectionManagerOptions['onCall'];

    // The Phase 4+5(+6) event pipeline / group discovery / rule engine /
    // AI / commands / archive / calls / moderation are all Supabase-only
    // (same reasoning as the Phase 3 auth/account storage split — see
    // ADR-011/ADR-012): there is no local-file equivalent for groups,
    // messages, rules, or any of this phase's new tables, so this wiring
    // simply doesn't exist in local-dev (file-storage) mode. The
    // dashboard's Groups/Activity pages explain this plainly rather than
    // silently doing nothing.
    if (this.storageMode?.kind === 'supabase') {
      const supabase = getSupabaseClient();
      const groupsRepository = new GroupsRepository(supabase);
      const contactsRepository = new ContactsRepository(supabase);
      const messagesRepository = new MessagesRepository(supabase);
      const rulesRepository = new RulesRepository(supabase);
      const ruleStateRepository = new RuleStateRepository(supabase);
      const moderationStateRepository = new ModerationStateRepository(supabase);
      const auditRepository = new AuditRepository(supabase);
      const aiUsageRepository = new AiUsageRepository(supabase);
      const mediaArchiveRepository = new MediaArchiveRepository(supabase);
      const callEventsRepository = new CallEventsRepository(supabase);
      const accountSettingsRepository = new AccountSettingsRepository(supabase);
      const notificationCooldowns = new NotificationCooldownRepository(supabase);
      const identityMapRepository = new IdentityMapRepository(supabase);
      const adminsRepository = new AdminsRepository(supabase);
      const ownerInbox = new OwnerInboxRepository(supabase);

      const sender = {
        sendTextMessage: (jid: string, text: string) => manager.sendTextMessage(jid, text),
      };
      const moderationCapabilities = {
        deleteMessage: (key: Parameters<WhatsAppConnectionManager['deleteMessage']>[0]) =>
          manager.deleteMessage(key),
        removeParticipant: (groupJid: string, participantJid: string) =>
          manager.removeParticipant(groupJid, participantJid),
      };

      // AI is a TOOL, constructed once per account and injected everywhere
      // it's needed (rule engine, .ai command) — never called unless an
      // explicit permission gate upstream (group ai_enabled + a specific
      // trigger) says so. undefined when OPENAI_API_KEY isn't configured;
      // every AI-dependent branch fails closed, never crashes. See
      // docs/DECISIONS.md and src/ai/aiService.ts.
      const ai =
        config.openai.configured && config.openai.apiKey
          ? {
              service: new AIService(
                new OpenAIProvider(config.openai.apiKey, config.openai.model),
                aiUsageRepository,
                createChildLogger(`whatsapp:account:${accountId}:ai`),
              ),
              usageRepository: aiUsageRepository,
            }
          : undefined;

      const ruleEngine = new RuleEngine({
        rulesRepository,
        ruleStateRepository,
        moderationStateRepository,
        auditRepository,
        ownerInbox,
        classifier: new DeterministicResponseClassifier(),
        sender,
        moderationCapabilities,
        ai,
        ownerJids: ownerJids(),
        logger: createChildLogger(`whatsapp:account:${accountId}:rules`),
      });

      const eventPipeline = new EventPipeline({
        accountId,
        groupsRepository,
        contactsRepository,
        messagesRepository,
        identityMapRepository,
        ruleEngine,
        auditRepository,
        accountSettingsRepository,
        deletedMessageHandlerDeps: {
          groupsRepository,
          messagesRepository,
          auditRepository,
          ownerInbox,
          notificationCooldowns,
          sender,
          ownerJids: ownerJids(),
          logger: createChildLogger(`whatsapp:account:${accountId}:deleted`),
        },
        privateDeletedMessageHandlerDeps: {
          contactsRepository,
          messagesRepository,
          auditRepository,
          ownerInbox,
          notificationCooldowns,
          sender,
          ownerJids: ownerJids(),
          logger: createChildLogger(`whatsapp:account:${accountId}:deleted-private`),
        },
        viewOnceHandlerDeps: {
          supabase,
          mediaArchiveRepository,
          auditRepository,
          logger: createChildLogger(`whatsapp:account:${accountId}:media`),
        },
        commandHandlerDeps: {
          groupsRepository,
          rulesRepository,
          auditRepository,
          identityMapRepository,
          sender,
          ai,
          ownerNumbers: config.authorization.ownerNumbers,
          adminNumbers: config.authorization.adminNumbers,
          adminsRepository,
          logger: createChildLogger(`whatsapp:account:${accountId}:commands`),
        },
        privateCommandHandlerDeps: {
          contactsRepository,
          rulesRepository,
          auditRepository,
          identityMapRepository,
          sender,
          ai,
          ownerNumbers: config.authorization.ownerNumbers,
          adminNumbers: config.authorization.adminNumbers,
          adminsRepository,
          logger: createChildLogger(`whatsapp:account:${accountId}:commands-private`),
        },
        logger: createChildLogger(`whatsapp:account:${accountId}:events`),
      });

      onMessage = (message, type) => {
        eventPipeline
          .handleMessage(message, type)
          .catch((err: unknown) =>
            log.error({ err, accountId }, 'Failed to process WhatsApp message event'),
          );
      };

      onGroupsDiscovered = (groups) => {
        handleDiscoveredGroups(accountId, groups, groupsRepository, identityMapRepository).catch(
          (err: unknown) =>
            log.error({ err, accountId }, 'Failed to record discovered WhatsApp groups'),
        );
      };

      onCall = (call) => {
        handleCallEvent(call, {
          accountId,
          accountSettingsRepository,
          callEventsRepository,
          auditRepository,
          ownerInbox,
          notificationCooldowns,
          sender,
          connection: { rejectCall: (callId, callFrom) => manager.rejectCall(callId, callFrom) },
          ownerJids: ownerJids(),
          logger: createChildLogger(`whatsapp:account:${accountId}:calls`),
        }).catch((err: unknown) => log.error({ err, accountId }, 'Failed to process call event'));
      };
    }

    manager = new WhatsAppConnectionManager({
      authProvider,
      logger: createChildLogger(`whatsapp:account:${accountId}`),
      reconnect: {
        baseMs: config.whatsapp.reconnectBaseMs,
        maxMs: config.whatsapp.reconnectMaxMs,
      },
      ...(onMessage ? { onMessage } : {}),
      ...(onGroupsDiscovered ? { onGroupsDiscovered } : {}),
      ...(onCall ? { onCall } : {}),
    });

    manager.onUpdate((snapshot) => {
      if (snapshot.state === 'connected') {
        this.store
          ?.touchLastConnected(accountId)
          .catch((err: unknown) =>
            log.warn({ err, accountId }, 'Failed to record last-connected time'),
          );
      }
    });

    return manager;
  }
}

function toSummary(account: AccountRecord): AccountSummary {
  return {
    id: account.id,
    label: account.label,
    createdAt: account.createdAt,
    status: account.manager.getStatus(),
  };
}

function normalizeLabel(rawLabel: string, fallbackIndex: number): string {
  const trimmed = rawLabel.trim().slice(0, MAX_LABEL_LENGTH);
  return trimmed.length > 0 ? trimmed : `WhatsApp Account ${fallbackIndex}`;
}

export const accountManager = new AccountManager(config.whatsapp.authDir);
