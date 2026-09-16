import { useCallback, useState } from 'react';
import { Alert, FlatList, Pressable, RefreshControl, StyleSheet, Text, View } from 'react-native';
import { useFocusEffect } from '@react-navigation/native';
import { transactions as transactionsApi } from '../api/endpoints';
import { ApiError } from '../api/client';
import { Tag } from '../components/Tag';
import { colors, fonts, spacing } from '../theme';
import type { Transaction } from '../api/types';

// Real order lifecycle (see backend/services/orderStateMachine.js):
// pending -> paid -> fulfilled -> completed, with cancelled/expired/refunded/
// disputed as the off-ramps. The seller marks an order fulfilled once
// they've handed it over; the buyer confirms receipt to complete it.
const NEXT_ACTION: Partial<Record<Transaction['status'], { label: string; run: (t: Transaction) => Promise<unknown> }>> = {
  paid: { label: 'Mark fulfilled', run: (t) => transactionsApi.markFulfilled(t.id) },
};
const BUYER_ACTION: Partial<Record<Transaction['status'], { label: string; run: (t: Transaction) => Promise<unknown> }>> = {
  fulfilled: { label: 'Confirm receipt', run: (t) => transactionsApi.confirmReceipt(t.id) },
};

const STATUS_LABEL: Record<Transaction['status'], string> = {
  pending: 'Pending payment',
  paid: 'Paid',
  fulfilled: 'Fulfilled',
  completed: 'Completed',
  cancelled: 'Cancelled',
  expired: 'Expired',
  refunded: 'Refunded',
  disputed: 'Disputed',
};

export function OrdersScreen() {
  const [tab, setTab] = useState<'buyer' | 'seller'>('buyer');
  const [all, setAll] = useState<Transaction[]>([]);
  const [loading, setLoading] = useState(true);
  const [busyId, setBusyId] = useState<number | null>(null);

  const load = useCallback(async () => {
    try {
      const res = await transactionsApi.mine();
      setAll(res.transactions);
    } catch (err) {
      Alert.alert('Could not load orders', err instanceof ApiError ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  }, []);

  useFocusEffect(
    useCallback(() => {
      load();
    }, [load])
  );

  const run = async (t: Transaction, action: { run: (t: Transaction) => Promise<unknown> }) => {
    setBusyId(t.id);
    try {
      await action.run(t);
      await load();
    } catch (err) {
      Alert.alert('Could not update order', err instanceof ApiError ? err.message : String(err));
    } finally {
      setBusyId(null);
    }
  };

  const data = all.filter((t) => t.role === tab);

  return (
    <View style={styles.container}>
      <Text style={styles.title}>Orders</Text>
      <View style={styles.tabs}>
        <Text style={[styles.tab, tab === 'buyer' && styles.tabActive]} onPress={() => setTab('buyer')}>
          Purchases
        </Text>
        <Text style={[styles.tab, tab === 'seller' && styles.tabActive]} onPress={() => setTab('seller')}>
          Sales
        </Text>
      </View>

      <FlatList
        data={data}
        keyExtractor={(t) => String(t.id)}
        refreshControl={<RefreshControl refreshing={loading} onRefresh={load} tintColor={colors.text} />}
        contentContainerStyle={styles.list}
        ItemSeparatorComponent={() => <View style={styles.sep} />}
        ListEmptyComponent={!loading ? <Text style={styles.empty}>Nothing here yet.</Text> : null}
        renderItem={({ item }) => {
          const action = tab === 'seller' ? NEXT_ACTION[item.status] : BUYER_ACTION[item.status];
          return (
            <View style={styles.row}>
              <View style={{ flex: 1 }}>
                <Text style={styles.itemTitle}>{item.listingTitle}</Text>
                <Text style={styles.itemSub}>
                  €{(item.total_amount_cents / 100).toFixed(0)} · {item.delivery_method}
                </Text>
                <View style={{ marginTop: 6 }}>
                  <Tag label={STATUS_LABEL[item.status]} tone={item.status === 'completed' ? 'accent' : 'neutral'} />
                </View>
              </View>
              {action && (
                <Pressable style={styles.action} onPress={() => run(item, action)} disabled={busyId === item.id}>
                  <Text style={styles.actionLabel}>{busyId === item.id ? '…' : action.label}</Text>
                </Pressable>
              )}
            </View>
          );
        }}
      />
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: colors.bg, paddingTop: spacing.xl },
  title: { fontFamily: fonts.heading, fontSize: 26, color: colors.text, paddingHorizontal: spacing.lg },
  tabs: { flexDirection: 'row', gap: spacing.lg, paddingHorizontal: spacing.lg, marginTop: spacing.md, marginBottom: spacing.sm },
  tab: { fontFamily: fonts.bodyMedium, fontSize: 13, color: colors.text, opacity: 0.5, paddingBottom: 6 },
  tabActive: { opacity: 1, color: colors.accent, borderBottomWidth: 2, borderBottomColor: colors.accent },
  list: { paddingHorizontal: spacing.lg, paddingBottom: spacing.xl },
  sep: { height: 2, backgroundColor: colors.divider, opacity: 0.15 },
  row: { flexDirection: 'row', alignItems: 'center', paddingVertical: 14, gap: spacing.md },
  itemTitle: { fontFamily: fonts.headingBold, fontSize: 14, color: colors.text },
  itemSub: { fontFamily: fonts.body, fontSize: 12, color: colors.text, opacity: 0.6, marginTop: 2 },
  action: { borderWidth: 2, borderColor: colors.text, paddingVertical: 8, paddingHorizontal: 10 },
  actionLabel: { fontFamily: fonts.bodyMedium, fontSize: 11, color: colors.text },
  empty: { fontFamily: fonts.body, fontSize: 13, color: colors.text, opacity: 0.6, textAlign: 'center', marginTop: spacing.xxl },
});
