import { useState, useEffect, useCallback } from "react";
import { connectService } from "../../../services/connect";

// Stripe Connect onboarding state.
//
// Kept separate from orders because it answers a different question -
// "can this seller be paid at all" rather than "what has been bought" -
// and because starting onboarding navigates the user off-site to Stripe,
// which is a very different interaction from anything else on the page.
export function usePayouts(enabled) {
  const [status, setStatus] = useState(null);
  const [onboarding, setOnboarding] = useState(false);
  const [error, setError] = useState(null);

  const refresh = useCallback(async () => {
    if (!enabled) return;
    try {
      setStatus(await connectService.status());
    } catch {
      // Payout status is supplementary. A failure here must not stop the
      // rest of the profile rendering - a seller who can't see their
      // payout state should still see their listings and orders.
    }
  }, [enabled]);

  useEffect(() => { refresh(); }, [refresh]);

  const startOnboarding = useCallback(async () => {
    setOnboarding(true);
    try {
      const { onboardingUrl } = await connectService.onboard();
      window.location.href = onboardingUrl;
      // Deliberately no setOnboarding(false) on success: the page is
      // navigating away, and clearing the flag would flash the button back
      // to its idle state mid-redirect.
    } catch (e) {
      setError(e.message);
      setOnboarding(false);
    }
  }, []);

  return { status, onboarding, error, refresh, startOnboarding };
}
