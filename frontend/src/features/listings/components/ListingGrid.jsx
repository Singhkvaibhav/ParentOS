import ListingCard from "./ListingCard";

export default function ListingGrid({ listings, loading, onSelect }) {
  if (loading) return <p className="muted">Loading listings...</p>;
  if (listings.length === 0) {
    return (
      <div className="empty-state">
        <p className="uk-display empty-state-title">No little treasures match yet.</p>
        <p className="muted">Try a different filter, or be the first to list one.</p>
      </div>
    );
  }
  return (
    <div className="listing-grid">
      {listings.map((item) => (
        <ListingCard key={item.id} listing={item} onClick={() => onSelect(item)} />
      ))}
    </div>
  );
}
