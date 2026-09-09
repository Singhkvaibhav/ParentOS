import { useAuth } from "../features/auth/hooks/useAuth";
import { useMyListings } from "../features/listings/hooks/useMyListings";
import { useToast } from "../hooks/useToast";
import SellerStats from "../features/profile/components/SellerStats";
import MyListings from "../features/listings/components/MyListings";
import PayoutSetup from "../features/payouts/components/PayoutSetup";
import OrderList from "../features/orders/components/OrderList";

// Composition only.
//
// This previously held three unrelated domains inline - orders, Stripe
// Connect payouts, and listing management - each with its own state,
// loading and actions. They shared nothing except being rendered on the
// same page. Splitting them by feature means a change to order handling no
// longer requires reading past payout logic to find it, and each piece can
// be tested and reused on its own.
export default function Profile() {
  const { user, logout } = useAuth();
  const { toast, showToast } = useToast();
  const listingsHook = useMyListings(!!user);

  if (!user) return <p className="muted p-6">Log in to see your profile.</p>;

  return (
    <section className="page-section">
      <h1 className="uk-display page-title">Your profile</h1>

      <div className="profile-card">
        <p><strong>{user.name}</strong></p>
        <p className="muted">{user.email}</p>
        <p className="muted small">{user.verified ? "Verified seller" : "Not yet verified"}</p>
        <button onClick={logout} className="btn btn-outline mt-4">Log out</button>
      </div>

      <PayoutSetup enabled={!!user} />

      <SellerStats />

      <MyListings listingsHook={listingsHook} showToast={showToast} />

      <OrderList enabled={!!user} showToast={showToast} />

      {toast && <div className="toast">{toast}</div>}
    </section>
  );
}
