import { useCallback, useState } from 'react';
import { Alert, FlatList, Pressable, RefreshControl, StyleSheet, Text, View } from 'react-native';
import { useFocusEffect, useNavigation } from '@react-navigation/native';
import { messages as messagesApi } from '../api/endpoints';
import { ApiError } from '../api/client';
import { Tag } from '../components/Tag';
import { colors, fonts, spacing } from '../theme';
import type { ConversationSummary } from '../api/types';

export function ChatListScreen() {
  const nav = useNavigation<any>();
  const [conversations, setConversations] = useState<ConversationSummary[]>([]);
  const [loading, setLoading] = useState(true);

  const load = useCallback(async () => {
    try {
      const res = await messagesApi.conversations();
      setConversations(res.conversations);
    } catch (err) {
      Alert.alert('Could not load chats', err instanceof ApiError ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  }, []);

  // Reload every time the tab regains focus, so a message sent from a
  // Thread screen (and its read receipt) shows up in the list right away.
  useFocusEffect(
    useCallback(() => {
      load();
    }, [load])
  );

  return (
    <View style={styles.container}>
      <Text style={styles.title}>Chat</Text>
      <FlatList
        data={conversations}
        keyExtractor={(c) => String(c.id)}
        refreshControl={<RefreshControl refreshing={loading} onRefresh={load} tintColor={colors.text} />}
        contentContainerStyle={styles.list}
        ListEmptyComponent={!loading ? <Text style={styles.empty}>No conversations yet — message a seller from Browse.</Text> : null}
        ItemSeparatorComponent={() => <View style={styles.sep} />}
        renderItem={({ item }) => (
          <Pressable
            style={styles.row}
            onPress={() =>
              nav.navigate('Thread', {
                conversationId: item.id,
                otherPartyName: item.otherPartyName,
                listingTitle: item.listingTitle,
              })
            }
          >
            <View style={{ flex: 1 }}>
              <Text style={styles.name}>{item.otherPartyName}</Text>
              <Text style={styles.listingTitle} numberOfLines={1}>{item.listingTitle}</Text>
              <Text style={styles.preview} numberOfLines={1}>
                {item.lastMessage ?? 'Say hello →'}
              </Text>
            </View>
            {item.unreadCount > 0 && <Tag label={String(item.unreadCount)} tone="accent" />}
          </Pressable>
        )}
      />
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: colors.bg, paddingTop: spacing.xl },
  title: { fontFamily: fonts.heading, fontSize: 26, color: colors.text, paddingHorizontal: spacing.lg, marginBottom: spacing.md },
  list: { paddingHorizontal: spacing.lg, paddingBottom: spacing.xl },
  sep: { height: 2, backgroundColor: colors.divider, opacity: 0.15 },
  row: { flexDirection: 'row', alignItems: 'center', paddingVertical: 14, gap: spacing.md },
  name: { fontFamily: fonts.headingBold, fontSize: 14, color: colors.text },
  listingTitle: { fontFamily: fonts.bodyMedium, fontSize: 11, color: colors.text, opacity: 0.7, marginTop: 2 },
  preview: { fontFamily: fonts.body, fontSize: 12, color: colors.text, opacity: 0.6, marginTop: 2 },
  empty: { fontFamily: fonts.body, fontSize: 13, color: colors.text, opacity: 0.6, textAlign: 'center', marginTop: spacing.xxl },
});
