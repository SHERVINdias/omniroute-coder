/**
 * SubscriptionPanel
 * ---------------------------------------------------------------------------
 * Tier status, the UPI purchase flow, and referral redemption.
 *
 * WHAT CHANGED, AND WHY IT MATTERS
 *
 * The previous panel asked the user to type any string into a "UPI Transaction
 * ID" box and posted it to an unauthenticated endpoint, which granted PRO
 * immediately. A single character bought a subscription, for any account.
 *
 * The flow here reflects what UPI can actually guarantee. The server issues an
 * order with an exact, slightly unusual amount — ₹69.07 rather than ₹69.00 —
 * which is what makes one bank credit attributable to one customer. The user
 * pays that exact amount, submits the UTR their app shows them, and an admin
 * confirms it against the bank. Every step's real state is shown rather than
 * implied, including the honest "waiting for an admin" state, because the
 * alternative is a customer who has paid and has no idea what is happening.
 *
 * On localhost the admin can switch on auto-approve, and the panel says so
 * plainly rather than making a test purchase look like a real one.
 */

'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import {
  X,
  Crown,
  Sparkles,
  Zap,
  Check,
  Copy,
  Loader2,
  Clock,
  AlertTriangle,
  Gift,
  ExternalLink,
  RefreshCw,
} from 'lucide-react';

/* -------------------------------------------------------------------------
 * Shapes returned by /api/subscription
 * ---------------------------------------------------------------------- */

type Tier = 'FREE' | 'PRO' | 'SPECIAL';
type OrderStatus = 'CREATED' | 'SUBMITTED' | 'APPROVED' | 'REJECTED' | 'EXPIRED';

interface StatusPayload {
  tier: Tier;
  unlimited: boolean;
  usageToday: number;
  dailyLimit: number;
  remainingToday: number | null;
  expiresAt: number | null;
  daysRemaining: number | null;
  isAdmin: boolean;
  priceRupees: string;
  paymentsConfigured: boolean;
}

interface OrderPayload {
  id: string;
  amountPaise: number;
  upiId: string;
  payeeName: string;
  status: OrderStatus;
  utr: string | null;
  expiresAt: number;
  reviewNote: string | null;
}

interface Instructions {
  order: OrderPayload;
  amountRupees: string;
  upiLink: string;
  reference: string;
  expiresInSeconds: number;
  autoApprove: boolean;
}

interface SubscriptionPanelProps {
  isOpen: boolean;
  onClose: () => void;
  userEmail: string;
  /** Bearer fallback for clients whose cookie has not been set yet. */
  authToken?: string | null;
  /** Lets the page refresh its own copy of the user after a tier change. */
  onTierChange?: (tier: Tier) => void;
}

export default function SubscriptionPanel({
  isOpen,
  onClose,
  userEmail,
  authToken,
  onTierChange,
}: SubscriptionPanelProps) {
  const [status, setStatus] = useState<StatusPayload | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [success, setSuccess] = useState('');

  const [view, setView] = useState<'overview' | 'pay' | 'referral'>('overview');
  const [instructions, setInstructions] = useState<Instructions | null>(null);
  const [utr, setUtr] = useState('');
  const [referralCode, setReferralCode] = useState('');
  const [busy, setBusy] = useState(false);
  const [copied, setCopied] = useState<string | null>(null);

  const pollRef = useRef<number | null>(null);

  /* onTierChange arrives as an inline arrow from the page, so it is a new
   * function on every parent render. Holding it in a ref keeps it out of the
   * dependency arrays below — otherwise loadStatus would be rebuilt on every
   * keystroke in the chat box, the mount effect would refetch each time, and
   * the polling interval would be torn down and restarted before it ever
   * reached 8 seconds. */
  const onTierChangeRef = useRef(onTierChange);
  useEffect(() => {
    onTierChangeRef.current = onTierChange;
  });

  /* Cookie first; the header is the fallback while the cookie propagates. */
  const authHeaders = useCallback((): HeadersInit => {
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
    };
    if (authToken) headers.Authorization = `Bearer ${authToken}`;
    return headers;
  }, [authToken]);

  /* ---------------------------------------------------------------------
   * Data
   * ------------------------------------------------------------------ */

  const loadStatus = useCallback(async () => {
    setLoading(true);
    setError('');
    try {
      const res = await fetch('/api/subscription', {
        headers: authHeaders(),
        credentials: 'include',
      });
      const data = await res.json().catch(() => ({}));

      if (!res.ok) {
        setError(
          res.status === 401
            ? 'Sign in to see your subscription.'
            : data.error || 'Could not load your subscription.',
        );
        return;
      }

      setStatus(data.status ?? null);
      if (data.status?.tier) onTierChangeRef.current?.(data.status.tier as Tier);
    } catch {
      setError('Could not reach the server.');
    } finally {
      setLoading(false);
    }
  }, [authHeaders]);

  const post = useCallback(
    async (body: Record<string, unknown>) => {
      const res = await fetch('/api/subscription', {
        method: 'POST',
        headers: authHeaders(),
        credentials: 'include',
        body: JSON.stringify(body),
      });
      const data = await res.json().catch(() => ({}));
      return { ok: res.ok, status: res.status, data } as const;
    },
    [authHeaders],
  );

  useEffect(() => {
    if (isOpen) void loadStatus();
  }, [isOpen, loadStatus]);

  /* Poll only while a payment is genuinely awaiting review. An always-on poll
   * would keep the dev server busy for no reason.
   *
   * `orderId` is pulled out first and checked directly rather than leaning on
   * the compiler to narrow `instructions` through an aliased optional-chain
   * comparison — that narrowing is fragile, and a string check needs no
   * cleverness to be correct. */
  useEffect(() => {
    const stop = () => {
      if (pollRef.current) {
        window.clearInterval(pollRef.current);
        pollRef.current = null;
      }
    };

    const orderId = instructions?.order.id;
    const waiting = instructions?.order.status === 'SUBMITTED';

    if (!isOpen || !orderId || !waiting) {
      stop();
      return;
    }

    pollRef.current = window.setInterval(() => {
      void (async () => {
        const { ok, data } = await post({ action: 'order-status', orderId });
        if (!ok) return;
        if (data.order) setInstructions(data as Instructions);
        if (data.status) {
          setStatus(data.status);
          if (data.order?.status === 'APPROVED') {
            setSuccess('Payment approved — your account is now PRO.');
            onTierChangeRef.current?.(data.status.tier as Tier);
          }
        }
      })();
    }, 8000);

    return stop;
    /* Depend on the two primitives that actually decide whether to poll, not
     * on the whole `instructions` object. Each poll calls setInstructions with
     * a freshly parsed object, so a dependency on the object itself tore the
     * interval down and rebuilt it after every tick. */
  }, [isOpen, instructions?.order.id, instructions?.order.status, post]);

  /* ---------------------------------------------------------------------
   * Actions
   * ------------------------------------------------------------------ */

  const startPayment = useCallback(async () => {
    setBusy(true);
    setError('');
    setSuccess('');
    const { ok, data } = await post({ action: 'create-order' });
    setBusy(false);

    if (!ok) {
      setError(data.error || 'Could not start a payment.');
      return;
    }
    setInstructions(data as Instructions);
    setUtr(data.order?.utr ?? '');
    setView('pay');
  }, [post]);

  const submitUtr = useCallback(async () => {
    if (!instructions) return;
    setBusy(true);
    setError('');

    const { ok, data } = await post({
      action: 'submit-utr',
      orderId: instructions.order.id,
      utr: utr.trim(),
    });
    setBusy(false);

    if (!ok) {
      setError(data.error || 'Could not record that reference.');
      return;
    }

    setInstructions({ ...instructions, order: data.order as OrderPayload });
    if (data.status) setStatus(data.status);
    setSuccess(data.message || 'Reference received.');
    if (data.autoApproved) onTierChangeRef.current?.('PRO');
  }, [instructions, post, utr]);

  const redeem = useCallback(async () => {
    setBusy(true);
    setError('');
    setSuccess('');

    const { ok, data } = await post({
      action: 'apply-referral',
      referralCode: referralCode.trim(),
    });
    setBusy(false);

    if (!ok) {
      setError(data.error || 'Could not redeem that code.');
      return;
    }
    setSuccess(data.message || 'Code applied.');
    setReferralCode('');
    if (data.status) {
      setStatus(data.status);
      onTierChangeRef.current?.(data.status.tier as Tier);
    }
    setView('overview');
  }, [post, referralCode]);

  const copy = useCallback(async (value: string, key: string) => {
    try {
      await navigator.clipboard.writeText(value);
      setCopied(key);
      window.setTimeout(() => setCopied(null), 1500);
    } catch {
      /* Clipboard blocked; the value is selectable on screen. */
    }
  }, []);

  if (!isOpen) return null;

  const tier: Tier = status?.tier ?? 'FREE';
  const order = instructions?.order;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm p-4">
      <div className="relative w-full max-w-lg max-h-[90vh] overflow-y-auto bg-zinc-900 border border-zinc-800 rounded-3xl shadow-2xl">
        {/* Header */}
        <div className="sticky top-0 z-10 flex items-center justify-between p-6 bg-zinc-900 border-b border-zinc-800">
          <div className="flex items-center gap-3">
            <div className="p-2 bg-amber-500/10 rounded-xl">
              <Crown className="w-5 h-5 text-amber-400" />
            </div>
            <div>
              <h2 className="text-xl font-semibold text-white">Subscription</h2>
              <p className="text-sm text-zinc-400 truncate max-w-[16rem]">
                {userEmail || 'Not signed in'}
              </p>
            </div>
          </div>
          <button
            onClick={onClose}
            aria-label="Close"
            className="p-2 hover:bg-zinc-800 rounded-xl transition-colors"
          >
            <X className="w-5 h-5 text-zinc-400" />
          </button>
        </div>

        <div className="p-6 space-y-4">
          {error && (
            <div className="flex gap-3 p-4 bg-rose-950/50 border border-rose-800/60 rounded-2xl">
              <AlertTriangle className="w-4 h-4 text-rose-300 shrink-0 mt-0.5" />
              <p className="text-sm text-rose-200">{error}</p>
            </div>
          )}
          {success && (
            <div className="flex gap-3 p-4 bg-emerald-950/40 border border-emerald-800/50 rounded-2xl">
              <Check className="w-4 h-4 text-emerald-300 shrink-0 mt-0.5" />
              <p className="text-sm text-emerald-200">{success}</p>
            </div>
          )}

          {loading && !status ? (
            <div className="flex items-center justify-center py-12 text-zinc-400 gap-2">
              <Loader2 className="w-5 h-5 animate-spin" />
              <span className="text-sm">Loading…</span>
            </div>
          ) : view === 'overview' ? (
            <OverviewView
              status={status}
              tier={tier}
              onUpgrade={() => void startPayment()}
              onReferral={() => {
                setView('referral');
                setError('');
                setSuccess('');
              }}
              onRefresh={() => void loadStatus()}
              busy={busy}
            />
          ) : view === 'referral' ? (
            <div className="space-y-4">
              <div className="flex items-center gap-2 text-zinc-200">
                <Gift className="w-4 h-4 text-fuchsia-400" />
                <h3 className="font-medium">Redeem a referral code</h3>
              </div>
              <p className="text-sm text-zinc-400">
                A valid code grants unlimited access permanently. Each code works
                once.
              </p>
              <input
                type="text"
                value={referralCode}
                onChange={(e) => setReferralCode(e.target.value.toUpperCase())}
                onKeyDown={(e) => e.key === 'Enter' && void redeem()}
                placeholder="ABCD2345"
                className="w-full px-4 py-3 bg-zinc-800/50 border border-zinc-700 rounded-xl text-white text-center text-lg font-mono tracking-[0.3em] placeholder:text-zinc-600 focus:outline-none focus:ring-2 focus:ring-fuchsia-500/50 focus:border-fuchsia-500"
                maxLength={12}
                disabled={busy}
                autoFocus
              />
              <div className="flex gap-3">
                <button
                  onClick={() => setView('overview')}
                  disabled={busy}
                  className="flex-1 py-3 bg-zinc-800 hover:bg-zinc-700 text-white rounded-xl transition-colors disabled:opacity-50"
                >
                  Back
                </button>
                <button
                  onClick={() => void redeem()}
                  disabled={busy || referralCode.trim().length < 4}
                  className="flex-1 py-3 bg-gradient-to-r from-fuchsia-500 to-purple-600 hover:from-fuchsia-600 hover:to-purple-700 text-white font-medium rounded-xl transition-all disabled:opacity-50 flex items-center justify-center gap-2"
                >
                  {busy ? <Loader2 className="w-4 h-4 animate-spin" /> : null}
                  Redeem
                </button>
              </div>
            </div>
          ) : (
            <PayView
              instructions={instructions}
              order={order}
              utr={utr}
              setUtr={setUtr}
              onSubmit={() => void submitUtr()}
              onBack={() => {
                setView('overview');
                setError('');
                void loadStatus();
              }}
              onCopy={(value, key) => void copy(value, key)}
              copied={copied}
              busy={busy}
            />
          )}
        </div>
      </div>
    </div>
  );
}

/* -------------------------------------------------------------------------
 * Overview
 * ---------------------------------------------------------------------- */

function OverviewView({
  status,
  tier,
  onUpgrade,
  onReferral,
  onRefresh,
  busy,
}: {
  status: StatusPayload | null;
  tier: Tier;
  onUpgrade: () => void;
  onReferral: () => void;
  onRefresh: () => void;
  busy: boolean;
}) {
  const unlimited = status?.unlimited ?? false;
  const used = status?.usageToday ?? 0;
  const limit = status?.dailyLimit ?? 3;
  const pct = unlimited ? 0 : Math.min(100, (used / Math.max(1, limit)) * 100);

  return (
    <div className="space-y-5">
      {/* Tier card */}
      <div
        className={`p-5 rounded-2xl border ${
          tier === 'SPECIAL'
            ? 'bg-fuchsia-950/30 border-fuchsia-800/50'
            : tier === 'PRO'
              ? 'bg-amber-950/30 border-amber-800/50'
              : 'bg-zinc-800/40 border-zinc-700'
        }`}
      >
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2">
            {tier === 'SPECIAL' ? (
              <Sparkles className="w-5 h-5 text-fuchsia-400" />
            ) : tier === 'PRO' ? (
              <Crown className="w-5 h-5 text-amber-400" />
            ) : (
              <Zap className="w-5 h-5 text-zinc-400" />
            )}
            <span className="text-lg font-semibold text-white">{tier}</span>
          </div>
          <button
            onClick={onRefresh}
            aria-label="Refresh"
            className="p-2 text-zinc-400 hover:text-white hover:bg-white/5 rounded-lg transition-colors"
          >
            <RefreshCw className="w-4 h-4" />
          </button>
        </div>

        {status?.isAdmin && (
          <p className="mt-2 text-sm text-emerald-300">
            Admin account — Deep Cowork is never metered for you.
          </p>
        )}

        {tier === 'PRO' && status?.daysRemaining !== null && status?.daysRemaining !== undefined && (
          <p className="mt-2 text-sm text-amber-200/80">
            {status.daysRemaining} day{status.daysRemaining === 1 ? '' : 's'} remaining
          </p>
        )}
        {tier === 'SPECIAL' && (
          <p className="mt-2 text-sm text-fuchsia-200/80">
            Unlimited access, no expiry.
          </p>
        )}
      </div>

      {/* Usage */}
      <div className="p-5 bg-zinc-800/40 border border-zinc-700 rounded-2xl space-y-3">
        <div className="flex items-center justify-between text-sm">
          <span className="text-zinc-300">Deep Cowork today</span>
          <span className="text-zinc-400 font-mono">
            {unlimited ? `${used} · unlimited` : `${used} / ${limit}`}
          </span>
        </div>
        {!unlimited && (
          <>
            <div className="h-2 bg-zinc-900 rounded-full overflow-hidden">
              <div
                className={`h-full rounded-full transition-all ${
                  pct >= 100 ? 'bg-rose-500' : 'bg-rose-400/70'
                }`}
                style={{ width: `${pct}%` }}
              />
            </div>
            <p className="text-xs text-zinc-500">
              The free allowance resets at midnight IST.
            </p>
          </>
        )}
      </div>

      {/* Actions */}
      {!unlimited && (
        <button
          onClick={onUpgrade}
          disabled={busy || status?.paymentsConfigured === false}
          className="w-full py-3 bg-gradient-to-r from-amber-500 to-orange-600 hover:from-amber-600 hover:to-orange-700 text-white font-medium rounded-xl transition-all disabled:opacity-50 disabled:cursor-not-allowed flex items-center justify-center gap-2"
        >
          {busy ? <Loader2 className="w-4 h-4 animate-spin" /> : <Crown className="w-4 h-4" />}
          Upgrade to PRO — ₹{status?.priceRupees ?? '69.00'}
        </button>
      )}

      {status?.paymentsConfigured === false && (
        <p className="text-xs text-amber-300/80 text-center">
          Payments are not set up yet — an admin needs to add a UPI ID first.
        </p>
      )}

      {tier !== 'SPECIAL' && (
        <button
          onClick={onReferral}
          className="w-full py-3 bg-zinc-800 hover:bg-zinc-700 text-zinc-200 rounded-xl transition-colors flex items-center justify-center gap-2"
        >
          <Gift className="w-4 h-4" />
          I have a referral code
        </button>
      )}
    </div>
  );
}

/* -------------------------------------------------------------------------
 * Payment
 * ---------------------------------------------------------------------- */

function PayView({
  instructions,
  order,
  utr,
  setUtr,
  onSubmit,
  onBack,
  onCopy,
  copied,
  busy,
}: {
  instructions: Instructions | null;
  order: OrderPayload | undefined;
  utr: string;
  setUtr: (value: string) => void;
  onSubmit: () => void;
  onBack: () => void;
  onCopy: (value: string, key: string) => void;
  copied: string | null;
  busy: boolean;
}) {
  if (!instructions || !order) {
    return (
      <div className="py-10 text-center text-sm text-zinc-400">
        No payment in progress.
      </div>
    );
  }

  /* Terminal states get their own screen — there is nothing left to do. */
  if (order.status === 'APPROVED') {
    return (
      <div className="py-8 text-center space-y-3">
        <Check className="w-10 h-10 text-emerald-400 mx-auto" />
        <h3 className="text-lg font-semibold text-white">You&apos;re on PRO</h3>
        <p className="text-sm text-zinc-400">
          Deep Cowork is now unlimited on this account.
        </p>
        <button
          onClick={onBack}
          className="mt-2 px-5 py-2.5 bg-zinc-800 hover:bg-zinc-700 text-white rounded-xl transition-colors"
        >
          Done
        </button>
      </div>
    );
  }

  if (order.status === 'REJECTED') {
    return (
      <div className="py-8 text-center space-y-3">
        <AlertTriangle className="w-10 h-10 text-rose-400 mx-auto" />
        <h3 className="text-lg font-semibold text-white">Payment not confirmed</h3>
        <p className="text-sm text-zinc-400 max-w-sm mx-auto">
          {order.reviewNote ||
            'The admin could not match this reference to a bank credit. If you believe this is wrong, get in touch with the UTR you submitted.'}
        </p>
        <button
          onClick={onBack}
          className="mt-2 px-5 py-2.5 bg-zinc-800 hover:bg-zinc-700 text-white rounded-xl transition-colors"
        >
          Back
        </button>
      </div>
    );
  }

  if (order.status === 'SUBMITTED') {
    return (
      <div className="space-y-4">
        <div className="p-5 bg-sky-950/30 border border-sky-800/50 rounded-2xl text-center space-y-2">
          <Clock className="w-8 h-8 text-sky-300 mx-auto" />
          <h3 className="font-semibold text-white">Waiting for confirmation</h3>
          <p className="text-sm text-sky-100/80">
            Your reference <span className="font-mono">{order.utr}</span> is with
            the admin. UPI does not notify this app when a transfer lands, so a
            person checks the bank credit against your exact amount — usually
            within a few hours.
          </p>
        </div>
        <div className="flex items-center justify-between px-4 py-3 bg-zinc-800/40 border border-zinc-700 rounded-xl text-sm">
          <span className="text-zinc-400">Amount paid</span>
          <span className="text-white font-mono">₹{instructions.amountRupees}</span>
        </div>
        <button
          onClick={onBack}
          className="w-full py-3 bg-zinc-800 hover:bg-zinc-700 text-white rounded-xl transition-colors"
        >
          Back
        </button>
      </div>
    );
  }

  /* CREATED — the payable state. */
  return (
    <div className="space-y-4">
      {instructions.autoApprove && (
        <div className="p-3 bg-amber-950/30 border border-amber-800/50 rounded-xl">
          <p className="text-xs text-amber-200">
            Auto-approve is on, so this order is confirmed without review. That
            is a testing setting.
          </p>
        </div>
      )}

      <div className="p-5 bg-zinc-800/40 border border-zinc-700 rounded-2xl space-y-4">
        <div>
          <p className="text-xs uppercase tracking-wide text-zinc-500">
            Pay exactly
          </p>
          <div className="flex items-baseline gap-2">
            <span className="text-3xl font-semibold text-white font-mono">
              ₹{instructions.amountRupees}
            </span>
            <button
              onClick={() => onCopy(instructions.amountRupees, 'amount')}
              className="p-1.5 text-zinc-400 hover:text-white hover:bg-white/5 rounded-lg transition-colors"
              aria-label="Copy amount"
            >
              {copied === 'amount' ? (
                <Check className="w-3.5 h-3.5 text-emerald-400" />
              ) : (
                <Copy className="w-3.5 h-3.5" />
              )}
            </button>
          </div>
          <p className="mt-1 text-xs text-zinc-500 leading-relaxed">
            The odd paise are deliberate — they are how your specific payment is
            identified in the bank statement. Paying a rounded amount instead
            makes it unmatchable.
          </p>
        </div>

        <div className="pt-3 border-t border-zinc-700/70">
          <p className="text-xs uppercase tracking-wide text-zinc-500">
            To this UPI ID
          </p>
          <div className="flex items-center gap-2">
            <span className="text-sm text-white font-mono break-all">
              {order.upiId}
            </span>
            <button
              onClick={() => onCopy(order.upiId, 'upi')}
              className="p-1.5 text-zinc-400 hover:text-white hover:bg-white/5 rounded-lg transition-colors shrink-0"
              aria-label="Copy UPI ID"
            >
              {copied === 'upi' ? (
                <Check className="w-3.5 h-3.5 text-emerald-400" />
              ) : (
                <Copy className="w-3.5 h-3.5" />
              )}
            </button>
          </div>
          <p className="mt-1 text-xs text-zinc-500">{order.payeeName}</p>
        </div>
      </div>

      <a
        href={instructions.upiLink}
        className="w-full py-3 bg-gradient-to-r from-emerald-500 to-teal-600 hover:from-emerald-600 hover:to-teal-700 text-white font-medium rounded-xl transition-all flex items-center justify-center gap-2"
      >
        <ExternalLink className="w-4 h-4" />
        Open in a UPI app
      </a>
      <p className="text-xs text-zinc-500 text-center -mt-2">
        Works on a phone. On a desktop browser nothing will open — pay from your
        phone using the ID and amount above.
      </p>

      <div className="space-y-2 pt-2">
        <label htmlFor="utr" className="text-sm font-medium text-zinc-300">
          After paying, enter the UTR
        </label>
        <input
          id="utr"
          type="text"
          value={utr}
          onChange={(e) => setUtr(e.target.value.toUpperCase().slice(0, 22))}
          onKeyDown={(e) => e.key === 'Enter' && utr.trim() && onSubmit()}
          placeholder="123456789012"
          className="w-full px-4 py-3 bg-zinc-800/50 border border-zinc-700 rounded-xl text-white font-mono tracking-wider placeholder:text-zinc-600 focus:outline-none focus:ring-2 focus:ring-emerald-500/50 focus:border-emerald-500"
          disabled={busy}
        />
        <p className="text-xs text-zinc-500">
          Your payment app labels this &ldquo;UTR&rdquo;, &ldquo;UPI transaction
          ID&rdquo;, or &ldquo;Reference number&rdquo;. It is usually 12 digits.
        </p>
      </div>

      <div className="flex gap-3">
        <button
          onClick={onBack}
          disabled={busy}
          className="flex-1 py-3 bg-zinc-800 hover:bg-zinc-700 text-white rounded-xl transition-colors disabled:opacity-50"
        >
          Back
        </button>
        <button
          onClick={onSubmit}
          disabled={busy || utr.trim().length < 12}
          className="flex-1 py-3 bg-gradient-to-r from-emerald-500 to-teal-600 hover:from-emerald-600 hover:to-teal-700 text-white font-medium rounded-xl transition-all disabled:opacity-50 disabled:cursor-not-allowed flex items-center justify-center gap-2"
        >
          {busy ? <Loader2 className="w-4 h-4 animate-spin" /> : null}
          I&apos;ve paid
        </button>
      </div>
    </div>
  );
}
