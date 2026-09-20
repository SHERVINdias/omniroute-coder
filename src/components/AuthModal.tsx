'use client';

/**
 * AuthModal
 * ---------------------------------------------------------------------------
 * Email / phone sign-in.
 *
 * The important change is honesty about delivery. The old version showed
 * "Development Mode: check your server console for an Ethereal email link" —
 * which was both the only path any code ever took, and useless to anyone who
 * was not watching the terminal. The server now tells this component whether
 * the code was really delivered, and when it was not, hands over the code so it
 * can be shown and filled in with one tap.
 *
 * Also added: a resend cooldown driven by the server's own retryAfter, so the
 * button is not offering something that will be refused; distinct copy for SMS
 * versus email; and remaining-attempt feedback instead of one generic failure.
 *
 * Every request sends credentials so the httpOnly session cookie is stored. The
 * token is still kept in localStorage because the rest of the app reads it from
 * there — the cookie is what server-side guards actually use.
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import {
  X,
  Mail,
  Phone,
  Lock,
  Loader2,
  ShieldCheck,
  KeyRound,
  Copy,
  Check,
  AlertTriangle,
} from 'lucide-react';

export interface AuthUserPayload {
  id: string;
  email: string;
  phone?: string | null;
  tier: string;
  role?: string;
  isAdmin?: boolean;
  referralCode?: string | null;
}

interface AuthModalProps {
  isOpen: boolean;
  onClose: () => void;
  onSuccess: (token: string, user: AuthUserPayload) => void;
}

type Step = 'identifier' | 'code';

/** Mirrors classifyIdentifier on the server, for labels and the keypad hint. */
function looksLikePhone(value: string): boolean {
  const digits = value.replace(/\D/g, '');
  return !value.includes('@') && digits.length >= 10;
}

export default function AuthModal({ isOpen, onClose, onSuccess }: AuthModalProps) {
  const [step, setStep] = useState<Step>('identifier');
  const [identifier, setIdentifier] = useState('');
  const [code, setCode] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');

  /* Delivery state reported by the server. */
  const [devCode, setDevCode] = useState<string | null>(null);
  /* 'beta' when the code is being shown because this account is on the
   * AUTH_BETA_TESTERS allowlist and a real provider failed, rather than because
   * the server has no mail configured. Worth distinguishing: on a deployed
   * server the generic "no provider is configured" wording is simply untrue,
   * and a tester who reads it reasonably concludes the app is broken. */
  const [revealReason, setRevealReason] = useState<'beta' | null>(null);
  const [deliveryError, setDeliveryError] = useState<string | null>(null);
  const [channel, setChannel] = useState<'email' | 'sms'>('email');
  const [cooldown, setCooldown] = useState(0);
  const [copied, setCopied] = useState(false);

  const codeInputRef = useRef<HTMLInputElement>(null);

  /* Tick the resend cooldown. Cleared on unmount so a closed modal does not
   * keep a timer alive. */
  useEffect(() => {
    if (cooldown <= 0) return;
    const timer = window.setInterval(() => {
      setCooldown((current) => (current <= 1 ? 0 : current - 1));
    }, 1000);
    return () => window.clearInterval(timer);
  }, [cooldown]);

  /* Focus the code field the moment it appears — with a one-field form, making
   * someone click into it is pure friction. */
  useEffect(() => {
    if (step === 'code') {
      const id = window.setTimeout(() => codeInputRef.current?.focus(), 60);
      return () => window.clearTimeout(id);
    }
  }, [step]);

  const reset = useCallback(() => {
    setStep('identifier');
    setIdentifier('');
    setCode('');
    setError('');
    setNotice('');
    setDevCode(null);
    setRevealReason(null);
    setDeliveryError(null);
    setChannel('email');
    setCooldown(0);
    setCopied(false);
  }, []);

  const handleClose = useCallback(() => {
    reset();
    onClose();
  }, [onClose, reset]);

  /* Escape closes, as it does everywhere else in the app. */
  useEffect(() => {
    if (!isOpen) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') handleClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [isOpen, handleClose]);

  const sendCode = useCallback(
    async (isResend = false) => {
      const value = identifier.trim();
      if (!value) {
        setError('Enter your email address or mobile number.');
        return;
      }

      setLoading(true);
      setError('');
      setNotice('');

      try {
        const res = await fetch('/api/auth/send-otp', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          credentials: 'include',
          body: JSON.stringify({ email: value }),
        });

        const data = await res.json().catch(() => ({}));

        if (!res.ok) {
          setError(data.error || 'Could not send a code.');
          if (typeof data.retryAfterSeconds === 'number') {
            setCooldown(data.retryAfterSeconds);
          }
          return;
        }

        setChannel(data.channel === 'sms' ? 'sms' : 'email');
        setDevCode(typeof data.devCode === 'string' ? data.devCode : null);
        setRevealReason(data.revealReason === 'beta' ? 'beta' : null);
        setDeliveryError(
          typeof data.deliveryError === 'string' ? data.deliveryError : null,
        );
        setNotice(typeof data.message === 'string' ? data.message : '');
        setCode('');
        setStep('code');
        /* Matches the server-side cooldown in otpCooldownRemaining. */
        setCooldown(isResend ? 45 : 30);
      } catch {
        setError('Could not reach the server. Is the app still running?');
      } finally {
        setLoading(false);
      }
    },
    [identifier],
  );

  const verifyCode = useCallback(
    async (submitted?: string) => {
      const value = (submitted ?? code).replace(/\D/g, '');
      if (value.length !== 6) {
        setError('Enter the 6-digit code.');
        return;
      }

      setLoading(true);
      setError('');

      try {
        const res = await fetch('/api/auth/verify-otp', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          credentials: 'include',
          body: JSON.stringify({ email: identifier.trim(), code: value }),
        });

        const data = await res.json().catch(() => ({}));

        if (!res.ok) {
          setError(data.error || 'That code did not work.');
          /* An exhausted or expired code cannot be retried, so send them back
           * rather than leaving them typing into a dead field. */
          if (data.reason === 'too_many_attempts' || data.reason === 'expired') {
            setCode('');
            setStep('identifier');
          }
          return;
        }

        try {
          localStorage.setItem('auth_token', data.token);
          localStorage.setItem('user', JSON.stringify(data.user));
        } catch {
          /* Private mode or a full quota. The cookie still carries the session,
           * so this is not fatal — do not block the sign-in over it. */
        }

        onSuccess(data.token, data.user as AuthUserPayload);
        reset();
        onClose();
      } catch {
        setError('Could not reach the server. Please try again.');
      } finally {
        setLoading(false);
      }
    },
    [code, identifier, onClose, onSuccess, reset],
  );

  const useDevCode = useCallback(() => {
    if (!devCode) return;
    setCode(devCode);
    void verifyCode(devCode);
  }, [devCode, verifyCode]);

  const copyDevCode = useCallback(async () => {
    if (!devCode) return;
    try {
      await navigator.clipboard.writeText(devCode);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1500);
    } catch {
      /* Clipboard access denied; the code is on screen anyway. */
    }
  }, [devCode]);

  if (!isOpen) return null;

  const isPhone = looksLikePhone(identifier);
  const IdentifierIcon = isPhone ? Phone : Mail;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm p-4">
      <div className="relative w-full max-w-md bg-zinc-900 border border-zinc-800 rounded-3xl shadow-2xl">
        {/* Header */}
        <div className="flex items-center justify-between p-6 border-b border-zinc-800">
          <div className="flex items-center gap-3">
            <div className="p-2 bg-rose-500/10 rounded-xl">
              {step === 'identifier' ? (
                <Lock className="w-5 h-5 text-rose-400" />
              ) : (
                <ShieldCheck className="w-5 h-5 text-rose-400" />
              )}
            </div>
            <div>
              <h2 className="text-xl font-semibold text-white">
                {step === 'identifier' ? 'Sign in' : 'Enter your code'}
              </h2>
              <p className="text-sm text-zinc-400">
                {step === 'identifier'
                  ? 'Email address or mobile number'
                  : channel === 'sms'
                    ? 'Sent by SMS'
                    : 'Sent by email'}
              </p>
            </div>
          </div>
          <button
            onClick={handleClose}
            aria-label="Close"
            className="p-2 hover:bg-zinc-800 rounded-xl transition-colors"
          >
            <X className="w-5 h-5 text-zinc-400" />
          </button>
        </div>

        {/* Content */}
        <div className="p-6 space-y-4">
          {error && (
            <div className="flex gap-3 p-4 bg-rose-950/50 border border-rose-800/60 rounded-2xl">
              <AlertTriangle className="w-4 h-4 text-rose-300 shrink-0 mt-0.5" />
              <p className="text-sm text-rose-200">{error}</p>
            </div>
          )}

          {step === 'identifier' ? (
            <>
              <div className="space-y-2">
                <label
                  htmlFor="auth-identifier"
                  className="text-sm font-medium text-zinc-300"
                >
                  Email or mobile number
                </label>
                <div className="relative">
                  <IdentifierIcon className="absolute left-3 top-1/2 -translate-y-1/2 w-5 h-5 text-zinc-500" />
                  <input
                    id="auth-identifier"
                    type="text"
                    inputMode={isPhone ? 'numeric' : 'email'}
                    autoComplete="username"
                    value={identifier}
                    onChange={(e) => setIdentifier(e.target.value)}
                    onKeyDown={(e) => e.key === 'Enter' && void sendCode()}
                    placeholder="you@example.com or 9876543210"
                    className="w-full pl-11 pr-4 py-3 bg-zinc-800/50 border border-zinc-700 rounded-xl text-white placeholder:text-zinc-500 focus:outline-none focus:ring-2 focus:ring-rose-500/50 focus:border-rose-500 transition-all"
                    disabled={loading}
                    autoFocus
                  />
                </div>
                <p className="text-xs text-zinc-500">
                  No password. We send a 6-digit code that works once.
                </p>
              </div>

              <button
                onClick={() => void sendCode()}
                disabled={loading || !identifier.trim()}
                className="w-full py-3 bg-gradient-to-r from-rose-500 to-pink-600 hover:from-rose-600 hover:to-pink-700 text-white font-medium rounded-xl transition-all disabled:opacity-50 disabled:cursor-not-allowed flex items-center justify-center gap-2"
              >
                {loading ? (
                  <>
                    <Loader2 className="w-5 h-5 animate-spin" />
                    <span>Sending…</span>
                  </>
                ) : (
                  <span>Send code</span>
                )}
              </button>
            </>
          ) : (
            <>
              {/* The code itself, when nothing could deliver it. */}
              {devCode && (
                <div className="p-4 bg-amber-950/30 border border-amber-800/50 rounded-2xl space-y-3">
                  <div className="flex items-start gap-2">
                    <KeyRound className="w-4 h-4 text-amber-300 shrink-0 mt-0.5" />
                    <p className="text-sm text-amber-100">
                      {revealReason === 'beta'
                        ? 'We could not deliver your code, so here it is directly. This account is on the beta-tester list while email sending is being set up.'
                        : deliveryError
                          ? 'Delivery failed, so here is your code directly.'
                          : 'No email or SMS provider is configured, so here is your code directly.'}
                    </p>
                  </div>

                  <div className="flex items-center gap-2">
                    <code className="flex-1 px-3 py-2 bg-black/40 border border-amber-800/40 rounded-xl text-2xl font-mono tracking-[0.4em] text-amber-50 text-center">
                      {devCode}
                    </code>
                    <button
                      onClick={() => void copyDevCode()}
                      aria-label="Copy code"
                      className="p-2.5 bg-amber-900/40 hover:bg-amber-900/60 rounded-xl transition-colors"
                    >
                      {copied ? (
                        <Check className="w-4 h-4 text-amber-200" />
                      ) : (
                        <Copy className="w-4 h-4 text-amber-200" />
                      )}
                    </button>
                  </div>

                  <button
                    onClick={useDevCode}
                    disabled={loading}
                    className="w-full py-2 text-sm font-medium text-amber-100 bg-amber-900/40 hover:bg-amber-900/60 rounded-xl transition-colors disabled:opacity-50"
                  >
                    Use this code
                  </button>

                  {deliveryError && (
                    <p className="text-xs text-amber-300/80 leading-relaxed">
                      {deliveryError}
                    </p>
                  )}
                </div>
              )}

              {!devCode && notice && (
                <div className="p-3 bg-emerald-950/30 border border-emerald-800/40 rounded-2xl">
                  <p className="text-sm text-emerald-200">{notice}</p>
                </div>
              )}

              <div className="space-y-2">
                <label htmlFor="auth-code" className="text-sm font-medium text-zinc-300">
                  6-digit code
                </label>
                <input
                  ref={codeInputRef}
                  id="auth-code"
                  type="text"
                  inputMode="numeric"
                  autoComplete="one-time-code"
                  value={code}
                  onChange={(e) => {
                    const next = e.target.value.replace(/\D/g, '').slice(0, 6);
                    setCode(next);
                    /* Submit as soon as six digits are in. Autofill from an SMS
                     * arrives all at once, and asking for a click afterwards is
                     * a step with no purpose. */
                    if (next.length === 6 && !loading) void verifyCode(next);
                  }}
                  onKeyDown={(e) => e.key === 'Enter' && void verifyCode()}
                  placeholder="000000"
                  className="w-full px-4 py-3 bg-zinc-800/50 border border-zinc-700 rounded-xl text-white text-center text-2xl font-mono tracking-[0.4em] placeholder:text-zinc-600 focus:outline-none focus:ring-2 focus:ring-rose-500/50 focus:border-rose-500 transition-all"
                  maxLength={6}
                  disabled={loading}
                />
                <p className="text-xs text-zinc-500 text-center">
                  For {identifier.trim()}
                </p>
              </div>

              <div className="flex gap-3">
                <button
                  onClick={() => {
                    setStep('identifier');
                    setCode('');
                    setError('');
                  }}
                  disabled={loading}
                  className="flex-1 py-3 bg-zinc-800 hover:bg-zinc-700 text-white font-medium rounded-xl transition-all disabled:opacity-50"
                >
                  Back
                </button>
                <button
                  onClick={() => void verifyCode()}
                  disabled={loading || code.length !== 6}
                  className="flex-1 py-3 bg-gradient-to-r from-rose-500 to-pink-600 hover:from-rose-600 hover:to-pink-700 text-white font-medium rounded-xl transition-all disabled:opacity-50 disabled:cursor-not-allowed flex items-center justify-center gap-2"
                >
                  {loading ? (
                    <>
                      <Loader2 className="w-5 h-5 animate-spin" />
                      <span>Verifying…</span>
                    </>
                  ) : (
                    <span>Verify</span>
                  )}
                </button>
              </div>

              <button
                onClick={() => void sendCode(true)}
                disabled={loading || cooldown > 0}
                className="w-full py-2 text-sm text-zinc-400 hover:text-white transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
              >
                {cooldown > 0
                  ? `Resend available in ${cooldown}s`
                  : "Didn't get it? Send another code"}
              </button>
            </>
          )}
        </div>

        <div className="p-6 pt-0">
          <p className="text-xs text-zinc-500 text-center">
            Signing in creates an account if you do not already have one.
          </p>
        </div>
      </div>
    </div>
  );
}
