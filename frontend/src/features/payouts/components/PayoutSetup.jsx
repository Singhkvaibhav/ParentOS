import { usePayouts } from "../hooks/usePayouts";

// Stripe Connect onboarding. Owns its own state, so the profile page
// doesn't carry payout concerns it otherwise has nothing to do with.
export default function PayoutSetup({ enabled }) {
  const { status, onboarding, error, startOnboarding } = usePayouts(enabled);

  return (
    <>
      <h2 className="uk-display page-title mt-5">Getting paid</h2>
      <div className="profile-card">
        {status?.payoutsEnabled ? (
          <p className="small">Payouts are set up - sale proceeds go straight to your bank account.</p>
        ) : (
          <>
            <p className="small mb-3">
              {status?.connected
                ? "Your payout account is started but not fully verified yet."
                : "Set up payouts so sale proceeds go directly to your bank account instead of staying with the platform."}
            </p>
            <button onClick={startOnboarding} disabled={onboarding} className="btn btn-moss">
              {onboarding ? "Redirecting..." : status?.connected ? "Finish setting up payouts" : "Set up payouts"}
            </button>
          </>
        )}
        {error && <p className="small">{error}</p>}
      </div>
    </>
  );
}
