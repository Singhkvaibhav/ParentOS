import { Routes, Route } from "react-router-dom";
import Home from "../pages/Home";
import Marketplace from "../pages/Marketplace";
import Listing from "../pages/Listing";
import Profile from "../pages/Profile";
import Messages from "../pages/Messages";
import SellerProfile from "../pages/SellerProfile";
import Moderation from "../pages/Moderation";

// The route table, separated from App so the shell (header, providers,
// error boundary) and the map of what exists can be read independently.
// Adding a page shouldn't mean editing a file that also owns layout.
export default function AppRoutes({ showToast }) {
  return (
    <Routes>
      <Route path="/" element={<Home />} />
      <Route path="/marketplace" element={<Marketplace showToast={showToast} />} />
      <Route path="/listing/:id" element={<Listing />} />
      <Route path="/profile" element={<Profile />} />
      <Route path="/messages" element={<Messages />} />
      <Route path="/seller/:id" element={<SellerProfile />} />
      <Route path="/moderation" element={<Moderation />} />
    </Routes>
  );
}
