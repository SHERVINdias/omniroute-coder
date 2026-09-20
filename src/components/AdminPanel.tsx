'use client';

/**
 * AdminPanel
 * ---------------------------------------------------------------------------
 * Payment review, referral codes, user management, and payment settings.
 *
 * WHY THIS IS A REWRITE RATHER THAN A PATCH
 *
 * The previous panel could not have worked against any version of /api/admin.
 * It asked for `?action=referrals` while the route implemented
 * `referral-codes`; it read `data.referralCodes` where the route sent `codes`;
 * it read `data.code` where the route sent `referralCode`; it sent
 * `{id: number}` to deactivate where the route matched on the code string —
 * and database ids are text like `ref_a1b2`, so a numeric id could never have
 * matched anything. Most decisively, the password was held in React state and
 * never attached to any subsequent request, so every call after the login
 * screen went out unauthenticated.
 *
 * There is no login screen here any more. Admin is a property of the session,
 * so if you can see this panel you are already authorised; if you are not, the
 * panel says so and explains how the first admin is established.
 *
 * The whole panel loads from one `overview` request. Four independent fetches
 * on open meant four independent ways to show a half-populated screen.
 */

import { useCallback, useEffect, useState } from 'react';
import {
  X,
  Key,
  Users,
  Shield,
  Copy,
  Check,
  Plus,
  Trash2,
  IndianRupee,
  Loader2,
  AlertTriangle,
  RefreshCw,
  BadgeCheck,
  Ban,
  Mail,
  MessageSquare,
} from 'lucide-react';

/* -------------------------------------------------------------------------
 * Shapes, mirroring what /api/admin?action=overview returns
 * ---------------------------------------------------------------------- */

interface ReferralCodeView {
  id: string;
  code: string;
  createdAt: number;
  createdBy: string;
  usedBy?: string | null;
  usedAt?: number | null;
  isActive: boolean;
  usedByEmail: string | null;
}

interface AdminUserView {
  id: string;
  email: string;
  phone: string | null;
  tier: 'FREE' | 'PRO' | 'SPECIAL';
  role: string;
  createdAt: number;
  lastLoginAt: number | null;
  referralCode: string | null;
  subscriptionEnd: number | null;
  usageToday: number;
}

interface AdminStats {
  totalUsers: number;
  freeUsers: number;
  proUsers: number;
  specialUsers: number;
  deepCoworkToday: number;
  referralCodesTotal: number;
  referralCodesUnused: number;
}

interface PaymentSettings {
  upiId: string | null;
  payeeName: string;
  pricePaise: number;
  priceRupees: string;
  autoApprove: boolean;
  configured: boolean;
  upiIdUpdatedAt: number | null;
}

interface DeliveryStatus {
  email: { provider: string; configured: boolean };
  sms: { provider: string; configured: boolean };
  revealsCodeWhenUnconfigured: boolean;
}

interface OrderRecord {
  id: string;
  userId: string;
  email: string;
  amountPaise: number;
  utr: string | null;
  status: 'CREATED' | 'SUBMITTED' | 'APPROVED' | 'REJECTED' | 'EXPIRED';
  createdAt: number;
  submittedAt: number | null;
  reviewNote: string | null;
}

interface OrderView {
  order: OrderRecord;
  amountRupees: string;
  reference: string;
}

interface Overview {
  admin: { id: string; email: string };
  stats: AdminStats;
  settings: PaymentSettings;
  delivery: DeliveryStatus;
  bootstrapAdmins: string[];
  pendingPayments: number;
  codes: ReferralCodeView[];
  users: AdminUserView[];
  orders: OrderView[];
}

interface AdminPanelProps {
  isOpen: boolean;
  onClose: () => void;
  /** Bearer fallback for the window between sign-in and the cookie landing. */
  authToken?: string | null;
}

type Tab = 'payments' | 'referrals' | 'users' | 'settings';

/* -------------------------------------------------------------------------
 * Small helpers
 * ---------------------------------------------------------------------- */

function formatDate(ms: number | null | undefined): string {
  if (!ms) return '—';
  return new Date(ms).toLocaleString('en-IN', {
    day: '2-digit',
    month: 'short',
    hour: '2-digit',
    minute: '2-digit',
  });
}

export default function AdminPanel({ isOpen, onClose, authToken }: AdminPanelProps) {
  const [tab, setTab] = useState<Tab>('payments');
  const [data, setData] = useState<Overview | null>(null);
  const [loading, setLoading] = useState(false);
  const [denied, setDenied] = useState(false);
  const [error, setError] = useState('');
  const [message, setMessage] = useState('');
  const [busy, setBusy] = useState('');
  const [copied, setCopied] = useState<string | null>(null);

  /* Draft fields for the settings tab. */
  const [newUpiId, setNewUpiId] = useState('');
  const [newPayee, setNewPayee] = useState('');
  const [newPrice, setNewPrice] = useState('');
  const [codeCount, setCodeCount] = useState(1);

  const headers = useCallback((): HeadersInit => {
    const h: Record<string, string> = { 'Content-Type': 'application/json' };
    if (authToken) h.Authorization = `Bearer ${authToken}`;
    return h;
  }, [authToken]);

  const load = useCallback(async () => {
    setLoading(true);
    setError('');
    try {
      const res = await fetch('/api/admin?action=overview', {
        headers: headers(),
        credentials: 'include',
      });
      const body = await res.json().catch(() => ({}));

      if (res.status === 401 || res.status === 403) {
        setDenied(true);
        setData(null);
        return;
      }
      if (!res.ok) {
        setError(body.error || 'Could not load admin data.');
        return;
      }

      setDenied(false);
      setData(body as Overview);
      /* Seed the settings drafts from what is actually stored, so the fields
       * show the current value instead of an empty box that looks unset. */
      setNewUpiId(body.settings?.upiId ?? '');
      setNewPayee(body.settings?.payeeName ?? '');
      setNewPrice(body.settings?.priceRupees ?? '');
    } catch {
      setError('Could not reach the server.');
    } finally {
      setLoading(false);
    }
  }, [headers]);

  useEffect(() => {
    if (isOpen) void load();
  }, [isOpen, load]);

  /* Every mutation goes through here so the refreshed overview, the busy flag
   * and the message banner are handled in exactly one place. */
  const act = useCallback(
    async (body: Record<string, unknown>, busyKey: string) => {
      setBusy(busyKey);
      setError('');
      setMessage('');
      try {
        const res = await fetch('/api/admin', {
          method: 'POST',
          headers: headers(),
          credentials: 'include',
          body: JSON.stringify(body),
        });
        const payload = await res.json().catch(() => ({}));

        if (!res.ok) {
          setError(payload.error || 'That action did not go through.');
          return null;
        }
        if (payload.message) setMessage(payload.message);
        await load();
        return payload as Record<string, unknown>;
      } catch {
        setError('Could not reach the server.');
        return null;
      } finally {
        setBusy('');
      }
    },
    [headers, load],
  );

  const copy = useCallback(async (value: string, key: string) => {
    try {
      await navigator.clipboard.writeText(value);
      setCopied(key);
      window.setTimeout(() => setCopied(null), 1500);
    } catch {
      /* Clipboard blocked; the value is on screen and selectable. */
    }
  }, []);

  if (!isOpen) return null;

  const pending = data?.orders.filter((o) => o.order.status === 'SUBMITTED') ?? [];

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm p-4">
      <div className="relative w-full max-w-3xl max-h-[90vh] flex flex-col bg-zinc-900 border border-zinc-800 rounded-3xl shadow-2xl">
        {/* Header */}
        <div className="flex items-center justify-between p-6 border-b border-zinc-800">
          <div className="flex items-center gap-3">
            <div className="p-2 bg-emerald-500/10 rounded-xl">
              <Shield className="w-5 h-5 text-emerald-400" />
            </div>
            <div>
              <h2 className="text-xl font-semibold text-white">Admin</h2>
              <p className="text-sm text-zinc-400">
                {data?.admin.email ?? 'Checking your access…'}
              </p>
            </div>
          </div>
          <div className="flex items-center gap-1">
            <button
              onClick={() => void load()}
              aria-label="Refresh"
              className="p-2 text-zinc-400 hover:text-white hover:bg-zinc-800 rounded-xl transition-colors"
            >
              <RefreshCw className={`w-4 h-4 ${loading ? 'animate-spin' : ''}`} />
            </button>
            <button
              onClick={onClose}
              aria-label="Close"
              className="p-2 hover:bg-zinc-800 rounded-xl transition-colors"
            >
              <X className="w-5 h-5 text-zinc-400" />
            </button>
          </div>
        </div>

        {denied ? (
          <div className="p-8 text-center space-y-3">
            <Shield className="w-10 h-10 text-zinc-600 mx-auto" />
            <h3 className="text-lg font-semibold text-white">
              This account is not an admin
            </h3>
            <p className="text-sm text-zinc-400 max-w-md mx-auto leading-relaxed">
              Admin access is granted by the allowlist in your environment —
              <code className="mx-1 px-1.5 py-0.5 bg-zinc-800 rounded text-zinc-300">
                ADMIN_EMAILS
              </code>
              and
              <code className="mx-1 px-1.5 py-0.5 bg-zinc-800 rounded text-zinc-300">
                ADMIN_PHONES
              </code>
              — and is re-applied every time one of those identities signs in.
              Sign in with an allowlisted email or phone number.
            </p>
            <button
              onClick={onClose}
              className="mt-2 px-5 py-2.5 bg-zinc-800 hover:bg-zinc-700 text-white rounded-xl transition-colors"
            >
              Close
            </button>
          </div>
        ) : (
          <>
            {/* Tabs */}
            <div className="flex gap-1 px-6 pt-4">
              {(
                [
                  ['payments', 'Payments', IndianRupee, pending.length],
                  ['referrals', 'Referrals', Key, 0],
                  ['users', 'Users', Users, 0],
                  ['settings', 'Settings', Shield, 0],
                ] as const
              ).map(([key, label, Icon, badge]) => (
                <button
                  key={key}
                  onClick={() => {
                    setTab(key);
                    setError('');
                    setMessage('');
                  }}
                  className={`flex items-center gap-2 px-4 py-2 text-sm rounded-xl transition-colors ${
                    tab === key
                      ? 'bg-zinc-800 text-white'
                      : 'text-zinc-400 hover:text-white hover:bg-zinc-800/50'
                  }`}
                >
                  <Icon className="w-4 h-4" />
                  {label}
                  {badge > 0 && (
                    <span className="px-1.5 py-0.5 text-xs bg-amber-500 text-black rounded-full font-medium">
                      {badge}
                    </span>
                  )}
                </button>
              ))}
            </div>

            {/* Body */}
            <div className="flex-1 overflow-y-auto p-6 space-y-4">
              {error && (
                <div className="flex gap-3 p-4 bg-rose-950/50 border border-rose-800/60 rounded-2xl">
                  <AlertTriangle className="w-4 h-4 text-rose-300 shrink-0 mt-0.5" />
                  <p className="text-sm text-rose-200">{error}</p>
                </div>
              )}
              {message && (
                <div className="flex gap-3 p-4 bg-emerald-950/40 border border-emerald-800/50 rounded-2xl">
                  <Check className="w-4 h-4 text-emerald-300 shrink-0 mt-0.5" />
                  <p className="text-sm text-emerald-200">{message}</p>
                </div>
              )}

              {loading && !data ? (
                <div className="flex items-center justify-center py-16 text-zinc-400 gap-2">
                  <Loader2 className="w-5 h-5 animate-spin" />
                  <span className="text-sm">Loading…</span>
                </div>
              ) : !data ? null : tab === 'payments' ? (
                <PaymentsTab
                  orders={data.orders}
                  settings={data.settings}
                  busy={busy}
                  onReview={(orderId, approve, note) =>
                    void act(
                      {
                        action: approve ? 'approve-payment' : 'reject-payment',
                        orderId,
                        ...(note ? { note } : {}),
                      },
                      orderId,
                    )
                  }
                />
              ) : tab === 'referrals' ? (
                <ReferralsTab
                  codes={data.codes}
                  stats={data.stats}
                  count={codeCount}
                  setCount={setCodeCount}
                  busy={busy}
                  copied={copied}
                  onCopy={(value, key) => void copy(value, key)}
                  onGenerate={() =>
                    void act(
                      { action: 'generate-referral', count: codeCount },
                      'generate',
                    )
                  }
                  onDeactivate={(code) =>
                    void act({ action: 'deactivate-referral', code }, code)
                  }
                  onDelete={(code) =>
                    void act({ action: 'delete-referral', code }, code)
                  }
                />
              ) : tab === 'users' ? (
                <UsersTab
                  users={data.users}
                  stats={data.stats}
                  adminId={data.admin.id}
                  busy={busy}
                  onSetRole={(userId, role) =>
                    void act({ action: 'set-role', userId, role }, userId)
                  }
                  onGrantPro={(userId) =>
                    void act({ action: 'grant-pro', userId }, userId)
                  }
                  onRevoke={(userId) =>
                    void act({ action: 'revoke-subscription', userId }, userId)
                  }
                />
              ) : (
                <SettingsTab
                  settings={data.settings}
                  delivery={data.delivery}
                  bootstrapAdmins={data.bootstrapAdmins}
                  newUpiId={newUpiId}
                  setNewUpiId={setNewUpiId}
                  newPayee={newPayee}
                  setNewPayee={setNewPayee}
                  newPrice={newPrice}
                  setNewPrice={setNewPrice}
                  busy={busy}
                  onSaveUpi={() =>
                    void act({ action: 'update-upi', upiId: newUpiId }, 'upi')
                  }
                  onSavePayee={() =>
                    void act({ action: 'update-payee', payeeName: newPayee }, 'payee')
                  }
                  onSavePrice={() =>
                    void act(
                      { action: 'update-price', priceRupees: newPrice },
                      'price',
                    )
                  }
                  onToggleAuto={(enabled) =>
                    void act({ action: 'set-auto-approve', enabled }, 'auto')
                  }
                />
              )}
            </div>
          </>
        )}
      </div>
    </div>
  );
}

/* -------------------------------------------------------------------------
 * Payments
 * ---------------------------------------------------------------------- */

function PaymentsTab({
  orders,
  settings,
  busy,
  onReview,
}: {
  orders: OrderView[];
  settings: PaymentSettings;
  busy: string;
  onReview: (orderId: string, approve: boolean, note?: string) => void;
}) {
  const [notes, setNotes] = useState<Record<string, string>>({});
  const submitted = orders.filter((o) => o.order.status === 'SUBMITTED');
  const rest = orders.filter((o) => o.order.status !== 'SUBMITTED');

  return (
    <div className="space-y-5">
      {settings.autoApprove && (
        <div className="flex gap-3 p-4 bg-amber-950/30 border border-amber-800/50 rounded-2xl">
          <AlertTriangle className="w-4 h-4 text-amber-300 shrink-0 mt-0.5" />
          <p className="text-sm text-amber-100">
            Auto-approve is ON, so any well-formed UTR grants PRO with no review
            and nothing reaches this queue. Turn it off in Settings before taking
            real money.
          </p>
        </div>
      )}

      <div>
        <h3 className="text-sm font-medium text-zinc-300 mb-1">
          Waiting for review ({submitted.length})
        </h3>
        <p className="text-xs text-zinc-500 mb-3 leading-relaxed">
          UPI gives this app no callback, so approval means one thing: open your
          bank or UPI app, find a credit for the exact amount below, confirm the
          UTR matches, then approve here.
        </p>

        {submitted.length === 0 ? (
          <p className="py-6 text-sm text-zinc-500 text-center">
            Nothing waiting.
          </p>
        ) : (
          <div className="space-y-3">
            {submitted.map(({ order, amountRupees }) => (
              <div
                key={order.id}
                className="p-4 bg-zinc-800/40 border border-zinc-700 rounded-2xl space-y-3"
              >
                <div className="flex items-start justify-between gap-3">
                  <div className="min-w-0">
                    <p className="text-sm text-white truncate">{order.email}</p>
                    <p className="text-xs text-zinc-500">
                      {formatDate(order.submittedAt)}
                    </p>
                  </div>
                  <span className="text-lg font-mono text-white shrink-0">
                    ₹{amountRupees}
                  </span>
                </div>

                <div className="px-3 py-2 bg-black/30 rounded-xl">
                  <p className="text-xs text-zinc-500">UTR</p>
                  <p className="text-sm font-mono text-zinc-200 break-all">
                    {order.utr}
                  </p>
                </div>

                <input
                  type="text"
                  value={notes[order.id] ?? ''}
                  onChange={(e) =>
                    setNotes((prev) => ({ ...prev, [order.id]: e.target.value }))
                  }
                  placeholder="Note (shown to the customer if you reject)"
                  className="w-full px-3 py-2 bg-zinc-900/60 border border-zinc-700 rounded-xl text-sm text-white placeholder:text-zinc-600 focus:outline-none focus:ring-2 focus:ring-emerald-500/40"
                />

                <div className="flex gap-2">
                  <button
                    onClick={() => onReview(order.id, false, notes[order.id])}
                    disabled={busy === order.id}
                    className="flex-1 py-2 text-sm bg-rose-900/40 hover:bg-rose-900/60 text-rose-200 rounded-xl transition-colors disabled:opacity-50 flex items-center justify-center gap-2"
                  >
                    <Ban className="w-3.5 h-3.5" />
                    Reject
                  </button>
                  <button
                    onClick={() => onReview(order.id, true, notes[order.id])}
                    disabled={busy === order.id}
                    className="flex-1 py-2 text-sm bg-emerald-600 hover:bg-emerald-500 text-white font-medium rounded-xl transition-colors disabled:opacity-50 flex items-center justify-center gap-2"
                  >
                    {busy === order.id ? (
                      <Loader2 className="w-3.5 h-3.5 animate-spin" />
                    ) : (
                      <BadgeCheck className="w-3.5 h-3.5" />
                    )}
                    Approve &amp; grant PRO
                  </button>
                </div>
              </div>
            ))}
          </div>
        )}
      </div>

      {rest.length > 0 && (
        <div>
          <h3 className="text-sm font-medium text-zinc-300 mb-3">Recent</h3>
          <div className="space-y-1.5">
            {rest.slice(0, 20).map(({ order, amountRupees }) => (
              <div
                key={order.id}
                className="flex items-center justify-between gap-3 px-3 py-2 bg-zinc-800/30 rounded-xl text-sm"
              >
                <span className="text-zinc-300 truncate">{order.email}</span>
                <div className="flex items-center gap-3 shrink-0">
                  <span className="text-zinc-400 font-mono text-xs">
                    ₹{amountRupees}
                  </span>
                  <span
                    className={`px-2 py-0.5 text-xs rounded-full ${
                      order.status === 'APPROVED'
                        ? 'bg-emerald-900/50 text-emerald-300'
                        : order.status === 'REJECTED'
                          ? 'bg-rose-900/50 text-rose-300'
                          : 'bg-zinc-700 text-zinc-400'
                    }`}
                  >
                    {order.status}
                  </span>
                </div>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

/* -------------------------------------------------------------------------
 * Referrals
 * ---------------------------------------------------------------------- */

function ReferralsTab({
  codes,
  stats,
  count,
  setCount,
  busy,
  copied,
  onCopy,
  onGenerate,
  onDeactivate,
  onDelete,
}: {
  codes: ReferralCodeView[];
  stats: AdminStats;
  count: number;
  setCount: (n: number) => void;
  busy: string;
  copied: string | null;
  onCopy: (value: string, key: string) => void;
  onGenerate: () => void;
  onDeactivate: (code: string) => void;
  onDelete: (code: string) => void;
}) {
  return (
    <div className="space-y-5">
      <div className="flex items-end gap-2">
        <div className="flex-1">
          <label htmlFor="code-count" className="text-xs text-zinc-400">
            How many
          </label>
          <input
            id="code-count"
            type="number"
            min={1}
            max={50}
            value={count}
            onChange={(e) =>
              setCount(Math.min(50, Math.max(1, Number(e.target.value) || 1)))
            }
            className="w-full mt-1 px-3 py-2 bg-zinc-800/50 border border-zinc-700 rounded-xl text-white focus:outline-none focus:ring-2 focus:ring-emerald-500/40"
          />
        </div>
        <button
          onClick={onGenerate}
          disabled={busy === 'generate'}
          className="px-4 py-2 bg-emerald-600 hover:bg-emerald-500 text-white font-medium rounded-xl transition-colors disabled:opacity-50 flex items-center gap-2"
        >
          {busy === 'generate' ? (
            <Loader2 className="w-4 h-4 animate-spin" />
          ) : (
            <Plus className="w-4 h-4" />
          )}
          Generate
        </button>
      </div>

      <p className="text-xs text-zinc-500">
        {stats.referralCodesUnused} unused of {stats.referralCodesTotal}. A
        redeemed code grants SPECIAL — unlimited access with no expiry — and
        works exactly once.
      </p>

      <div className="space-y-1.5">
        {codes.length === 0 ? (
          <p className="py-6 text-sm text-zinc-500 text-center">
            No codes yet.
          </p>
        ) : (
          codes.map((c) => {
            const used = Boolean(c.usedBy);
            return (
              <div
                key={c.id}
                className="flex items-center gap-3 px-3 py-2.5 bg-zinc-800/40 border border-zinc-700/60 rounded-xl"
              >
                <code
                  className={`font-mono tracking-widest text-sm ${
                    used || !c.isActive ? 'text-zinc-500 line-through' : 'text-white'
                  }`}
                >
                  {c.code}
                </code>

                <div className="flex-1 min-w-0">
                  <p className="text-xs text-zinc-500 truncate">
                    {used
                      ? `Redeemed by ${c.usedByEmail ?? c.usedBy} · ${formatDate(c.usedAt)}`
                      : c.isActive
                        ? `Created ${formatDate(c.createdAt)}`
                        : 'Deactivated'}
                  </p>
                </div>

                {!used && c.isActive && (
                  <button
                    onClick={() => onCopy(c.code, c.code)}
                    aria-label="Copy code"
                    className="p-1.5 text-zinc-400 hover:text-white hover:bg-white/5 rounded-lg transition-colors"
                  >
                    {copied === c.code ? (
                      <Check className="w-3.5 h-3.5 text-emerald-400" />
                    ) : (
                      <Copy className="w-3.5 h-3.5" />
                    )}
                  </button>
                )}

                {c.isActive && !used && (
                  <button
                    onClick={() => onDeactivate(c.code)}
                    disabled={busy === c.code}
                    title="Deactivate"
                    className="p-1.5 text-zinc-400 hover:text-amber-300 hover:bg-white/5 rounded-lg transition-colors disabled:opacity-50"
                  >
                    <Ban className="w-3.5 h-3.5" />
                  </button>
                )}

                {!used && (
                  <button
                    onClick={() => onDelete(c.code)}
                    disabled={busy === c.code}
                    title="Delete"
                    className="p-1.5 text-zinc-400 hover:text-rose-300 hover:bg-white/5 rounded-lg transition-colors disabled:opacity-50"
                  >
                    <Trash2 className="w-3.5 h-3.5" />
                  </button>
                )}
              </div>
            );
          })
        )}
      </div>
    </div>
  );
}

/* -------------------------------------------------------------------------
 * Users
 * ---------------------------------------------------------------------- */

function UsersTab({
  users,
  stats,
  adminId,
  busy,
  onSetRole,
  onGrantPro,
  onRevoke,
}: {
  users: AdminUserView[];
  stats: AdminStats;
  adminId: string;
  busy: string;
  onSetRole: (userId: string, role: 'ADMIN' | 'USER') => void;
  onGrantPro: (userId: string) => void;
  onRevoke: (userId: string) => void;
}) {
  const [query, setQuery] = useState('');
  const needle = query.trim().toLowerCase();
  const shown = needle
    ? users.filter(
        (u) =>
          u.email.toLowerCase().includes(needle) ||
          (u.phone ?? '').includes(needle),
      )
    : users;

  return (
    <div className="space-y-4">
      <div className="grid grid-cols-4 gap-2">
        {(
          [
            ['Total', stats.totalUsers],
            ['Free', stats.freeUsers],
            ['Pro', stats.proUsers],
            ['Special', stats.specialUsers],
          ] as const
        ).map(([label, value]) => (
          <div
            key={label}
            className="px-3 py-2 bg-zinc-800/40 border border-zinc-700/60 rounded-xl text-center"
          >
            <p className="text-lg font-semibold text-white">{value}</p>
            <p className="text-xs text-zinc-500">{label}</p>
          </div>
        ))}
      </div>

      <input
        type="text"
        value={query}
        onChange={(e) => setQuery(e.target.value)}
        placeholder="Filter by email or phone"
        className="w-full px-3 py-2 bg-zinc-800/50 border border-zinc-700 rounded-xl text-sm text-white placeholder:text-zinc-600 focus:outline-none focus:ring-2 focus:ring-emerald-500/40"
      />

      <div className="space-y-1.5">
        {shown.map((u) => {
          const isSelf = u.id === adminId;
          return (
            <div
              key={u.id}
              className="p-3 bg-zinc-800/40 border border-zinc-700/60 rounded-xl space-y-2"
            >
              <div className="flex items-center justify-between gap-3">
                <div className="min-w-0">
                  <p className="text-sm text-white truncate">
                    {u.email}
                    {isSelf && (
                      <span className="ml-2 text-xs text-emerald-400">you</span>
                    )}
                  </p>
                  <p className="text-xs text-zinc-500">
                    {u.phone ? `${u.phone} · ` : ''}
                    {u.usageToday} today · last seen {formatDate(u.lastLoginAt)}
                  </p>
                </div>
                <div className="flex items-center gap-1.5 shrink-0">
                  {u.role === 'ADMIN' && (
                    <span className="px-2 py-0.5 text-xs bg-emerald-900/50 text-emerald-300 rounded-full">
                      ADMIN
                    </span>
                  )}
                  <span
                    className={`px-2 py-0.5 text-xs rounded-full ${
                      u.tier === 'SPECIAL'
                        ? 'bg-fuchsia-900/50 text-fuchsia-300'
                        : u.tier === 'PRO'
                          ? 'bg-amber-900/50 text-amber-300'
                          : 'bg-zinc-700 text-zinc-400'
                    }`}
                  >
                    {u.tier}
                  </span>
                </div>
              </div>

              <div className="flex flex-wrap gap-1.5">
                <button
                  onClick={() =>
                    onSetRole(u.id, u.role === 'ADMIN' ? 'USER' : 'ADMIN')
                  }
                  disabled={busy === u.id || isSelf}
                  title={
                    isSelf
                      ? 'You cannot change your own role'
                      : u.role === 'ADMIN'
                        ? 'Remove admin'
                        : 'Make admin'
                  }
                  className="px-2.5 py-1 text-xs bg-zinc-700/60 hover:bg-zinc-700 text-zinc-200 rounded-lg transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
                >
                  {u.role === 'ADMIN' ? 'Remove admin' : 'Make admin'}
                </button>
                <button
                  onClick={() => onGrantPro(u.id)}
                  disabled={busy === u.id}
                  className="px-2.5 py-1 text-xs bg-amber-900/40 hover:bg-amber-900/60 text-amber-200 rounded-lg transition-colors disabled:opacity-40"
                >
                  Grant 1 month PRO
                </button>
                {u.tier !== 'FREE' && (
                  <button
                    onClick={() => onRevoke(u.id)}
                    disabled={busy === u.id}
                    className="px-2.5 py-1 text-xs bg-rose-900/40 hover:bg-rose-900/60 text-rose-200 rounded-lg transition-colors disabled:opacity-40"
                  >
                    Revoke
                  </button>
                )}
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}

/* -------------------------------------------------------------------------
 * Settings
 * ---------------------------------------------------------------------- */

function SettingsTab({
  settings,
  delivery,
  bootstrapAdmins,
  newUpiId,
  setNewUpiId,
  newPayee,
  setNewPayee,
  newPrice,
  setNewPrice,
  busy,
  onSaveUpi,
  onSavePayee,
  onSavePrice,
  onToggleAuto,
}: {
  settings: PaymentSettings;
  delivery: DeliveryStatus;
  bootstrapAdmins: string[];
  newUpiId: string;
  setNewUpiId: (v: string) => void;
  newPayee: string;
  setNewPayee: (v: string) => void;
  newPrice: string;
  setNewPrice: (v: string) => void;
  busy: string;
  onSaveUpi: () => void;
  onSavePayee: () => void;
  onSavePrice: () => void;
  onToggleAuto: (enabled: boolean) => void;
}) {
  return (
    <div className="space-y-6">
      {/* Payments */}
      <section className="space-y-3">
        <h3 className="text-sm font-medium text-zinc-300">Payments</h3>

        {!settings.configured && (
          <div className="flex gap-3 p-3 bg-amber-950/30 border border-amber-800/50 rounded-xl">
            <AlertTriangle className="w-4 h-4 text-amber-300 shrink-0 mt-0.5" />
            <p className="text-sm text-amber-100">
              No UPI ID is set, so nobody can start a payment. Add one below.
            </p>
          </div>
        )}

        <Field
          label="UPI ID"
          hint="Where customer payments land, e.g. yourname@okaxis."
          value={newUpiId}
          onChange={setNewUpiId}
          placeholder="yourname@okaxis"
          onSave={onSaveUpi}
          saving={busy === 'upi'}
        />
        <Field
          label="Payee name"
          hint="What the customer's UPI app shows as the recipient."
          value={newPayee}
          onChange={setNewPayee}
          placeholder="OmniRoute"
          onSave={onSavePayee}
          saving={busy === 'payee'}
        />
        <Field
          label="PRO price (₹)"
          hint="A few paise are added per order to make each payment identifiable."
          value={newPrice}
          onChange={setNewPrice}
          placeholder="69"
          onSave={onSavePrice}
          saving={busy === 'price'}
        />

        <label className="flex items-start gap-3 p-3 bg-zinc-800/40 border border-zinc-700/60 rounded-xl cursor-pointer">
          <input
            type="checkbox"
            checked={settings.autoApprove}
            onChange={(e) => onToggleAuto(e.target.checked)}
            disabled={busy === 'auto'}
            className="mt-0.5 w-4 h-4 accent-amber-500"
          />
          <span>
            <span className="block text-sm text-white">
              Auto-approve payments
            </span>
            <span className="block text-xs text-zinc-500 leading-relaxed">
              Grants PRO as soon as a well-formed UTR is submitted, without
              checking the bank. Useful on localhost; leave it off in production
              or anyone can type twelve digits and get a subscription.
            </span>
          </span>
        </label>
      </section>

      {/* OTP delivery */}
      <section className="space-y-3">
        <h3 className="text-sm font-medium text-zinc-300">Code delivery</h3>

        <div className="grid grid-cols-2 gap-2">
          <StatusChip
            icon={Mail}
            label="Email"
            provider={delivery.email.provider}
            configured={delivery.email.configured}
          />
          <StatusChip
            icon={MessageSquare}
            label="SMS"
            provider={delivery.sms.provider}
            configured={delivery.sms.configured}
          />
        </div>

        {delivery.revealsCodeWhenUnconfigured && (
          <p className="text-xs text-amber-300/90 leading-relaxed">
            With no provider configured, sign-in codes are shown directly in the
            browser so login still works. That is fine on localhost and unsafe
            anywhere else — set GMAIL_USER and GMAIL_APP_PASSWORD (and the
            TWILIO_* keys for SMS) in .env.local before exposing this app.
          </p>
        )}
      </section>

      {/* Bootstrap admins */}
      <section className="space-y-2">
        <h3 className="text-sm font-medium text-zinc-300">Permanent admins</h3>
        <p className="text-xs text-zinc-500 leading-relaxed">
          These identities get the admin role re-applied on every sign-in, so
          admin access cannot be lost through a bad database edit. Change them
          with ADMIN_EMAILS and ADMIN_PHONES in .env.local.
        </p>
        <div className="flex flex-wrap gap-1.5">
          {bootstrapAdmins.map((value) => (
            <code
              key={value}
              className="px-2 py-1 text-xs bg-zinc-800 text-zinc-300 rounded-lg"
            >
              {value}
            </code>
          ))}
        </div>
      </section>
    </div>
  );
}

function Field({
  label,
  hint,
  value,
  onChange,
  placeholder,
  onSave,
  saving,
}: {
  label: string;
  hint: string;
  value: string;
  onChange: (v: string) => void;
  placeholder: string;
  onSave: () => void;
  saving: boolean;
}) {
  return (
    <div className="space-y-1">
      <label className="text-xs text-zinc-400">{label}</label>
      <div className="flex gap-2">
        <input
          type="text"
          value={value}
          onChange={(e) => onChange(e.target.value)}
          onKeyDown={(e) => e.key === 'Enter' && onSave()}
          placeholder={placeholder}
          className="flex-1 px-3 py-2 bg-zinc-800/50 border border-zinc-700 rounded-xl text-sm text-white placeholder:text-zinc-600 focus:outline-none focus:ring-2 focus:ring-emerald-500/40"
        />
        <button
          onClick={onSave}
          disabled={saving || !value.trim()}
          className="px-4 py-2 bg-zinc-700 hover:bg-zinc-600 text-white text-sm rounded-xl transition-colors disabled:opacity-40 flex items-center gap-2"
        >
          {saving ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : null}
          Save
        </button>
      </div>
      <p className="text-xs text-zinc-500">{hint}</p>
    </div>
  );
}

function StatusChip({
  icon: Icon,
  label,
  provider,
  configured,
}: {
  icon: typeof Mail;
  label: string;
  provider: string;
  configured: boolean;
}) {
  return (
    <div
      className={`flex items-center gap-2 px-3 py-2 rounded-xl border ${
        configured
          ? 'bg-emerald-950/30 border-emerald-800/50'
          : 'bg-zinc-800/40 border-zinc-700/60'
      }`}
    >
      <Icon
        className={`w-4 h-4 ${configured ? 'text-emerald-400' : 'text-zinc-500'}`}
      />
      <div className="min-w-0">
        <p className="text-sm text-white">{label}</p>
        <p className="text-xs text-zinc-500 truncate">
          {configured ? provider : 'not configured'}
        </p>
      </div>
    </div>
  );
}
