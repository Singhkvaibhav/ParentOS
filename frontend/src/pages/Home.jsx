import { Link } from "react-router-dom";

export default function Home() {
  return (
    <section className="hero">
      <div className="hero-content">
        <h1 className="uk-display hero-title">Clothes, toys and gear your child's outgrown - new hands are waiting.</h1>
        <p className="hero-subtitle">A small, local marketplace for Helsinki-area families buying and selling children's clothes, accessories and toys.</p>
        <div className="hero-actions">
          <Link to="/marketplace" className="btn btn-paper">Browse listings</Link>
          <Link to="/marketplace?sell=1" className="btn btn-outline">Sell something</Link>
        </div>
      </div>
    </section>
  );
}
