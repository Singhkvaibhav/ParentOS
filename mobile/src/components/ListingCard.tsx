import { Image, Pressable, StyleSheet, Text, View } from 'react-native';
import { colors, fonts } from '../theme';
import { Tag } from './Tag';
import type { Listing } from '../api/types';

// Same diagonal-stripe placeholder pattern as the design canvas's `.ph` class
// - shown only when a listing has no photo_url yet.
function PhotoPlaceholder({ label }: { label: string }) {
  return (
    <View style={styles.photo}>
      <Text style={styles.photoLabel}>{label}</Text>
    </View>
  );
}

export function ListingCard({ listing, onPress }: { listing: Listing; onPress: () => void }) {
  return (
    <Pressable style={styles.card} onPress={onPress}>
      {listing.photo_url ? (
        // The ~400px thumbnail, not the full-size photo - this card renders
        // in a scrolling grid of many at once, and mobile data is the
        // actual cost here, not decode time. Falls back to the full photo
        // for listings created before thumbnails existed.
        <Image source={{ uri: listing.photo_thumb_url || listing.photo_url }} style={styles.photo} resizeMode="cover" />
      ) : (
        <PhotoPlaceholder label={listing.subcategory || listing.category} />
      )}
      <View style={styles.body}>
        <Text style={styles.title} numberOfLines={2}>{listing.title}</Text>
        <View style={styles.row}>
          <Text style={styles.area}>{listing.area}</Text>
          <Text style={styles.price}>€{(listing.price_cents / 100).toFixed(0)}</Text>
        </View>
        <Tag label={listing.seller_verified ? 'Verified' : 'New seller'} tone={listing.seller_verified ? 'accent' : 'neutral'} />
      </View>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  card: { flex: 1 },
  photo: {
    height: 130,
    backgroundColor: colors.neutral300,
    justifyContent: 'flex-end',
    alignItems: 'flex-start',
  },
  photoLabel: {
    fontFamily: fonts.body,
    fontSize: 9,
    letterSpacing: 1,
    textTransform: 'uppercase',
    color: colors.neutral700,
    backgroundColor: colors.bg,
    paddingHorizontal: 5,
    paddingVertical: 2,
    margin: 6,
  },
  body: { paddingVertical: 8, gap: 6 },
  title: { fontFamily: fonts.headingBold, fontSize: 12, color: colors.text, lineHeight: 16 },
  row: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' },
  area: { fontFamily: fonts.body, fontSize: 11, color: colors.text, opacity: 0.6 },
  price: { fontFamily: fonts.headingBold, fontSize: 13, color: colors.text },
});
