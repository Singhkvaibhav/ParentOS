-- Completes the "Pickup / Delivery -> Review" step of the user journey.
--
-- 'completed' was already a permitted transaction status and was already
-- treated as review-eligible, but nothing ever set it: every transaction
-- stayed 'paid' forever. The handover step existed on paper only.
--
-- notifications.type has a CHECK constraint, so the new event type has to
-- be added to it or the insert would fail at runtime.
ALTER TABLE notifications DROP CONSTRAINT IF EXISTS notifications_type_check;
ALTER TABLE notifications ADD CONSTRAINT notifications_type_check CHECK (type IN (
  'message_received',
  'item_sold',
  'purchase_confirmed',
  'review_received',
  'listing_taken_down',
  'order_completed'
));
