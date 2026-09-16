-- Migration 023: a second, small image alongside each listing/upload photo.
--
-- The marketplace grid renders many listing photos on screen at once, but
-- every one of them was the same 1280-1600px image the detail view uses -
-- fine for one photo, wasteful bandwidth (especially on mobile data) for a
-- page of thirty. Both upload paths (images/routes.js's inline route and
-- imageProcessingService.js's presigned-upload finalize step) now also
-- produce a ~400px thumbnail; these columns are where its URL is recorded
-- alongside the existing full-size one. Nullable and additive - existing
-- rows simply have no thumbnail until their photo is replaced, and every
-- reader falls back to the full-size photo_url when it's absent.
ALTER TABLE listings ADD COLUMN IF NOT EXISTS photo_thumb_url TEXT;
ALTER TABLE uploads ADD COLUMN IF NOT EXISTS public_thumb_url TEXT;
