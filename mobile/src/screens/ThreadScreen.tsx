import { useCallback, useEffect, useState } from 'react';
import { Alert, FlatList, KeyboardAvoidingView, Platform, Pressable, StyleSheet, Text, TextInput, View } from 'react-native';
import { useNavigation, useRoute } from '@react-navigation/native';
import { messages as messagesApi } from '../api/endpoints';
import { ApiError } from '../api/client';
import { colors, fonts, spacing } from '../theme';
import type { Message } from '../api/types';
import { useAuth } from '../state/AuthContext';

// Two ways to land here (see navigation/types.ts): with an existing
// conversationId (from Chat), or with only a listingId (from a listing in
// Browse/Search, where no conversation exists yet). The backend keeps these
// as genuinely different endpoints - GET/POST .../messages/thread for
// "my conversation about this listing" vs. .../conversations/:id/reply for
// an ongoing one - so this screen starts in "new" mode and switches to
// "existing" mode the moment the first message creates a conversation.
export function ThreadScreen() {
  const route = useRoute<any>();
  const nav = useNavigation<any>();
  const { user } = useAuth();
  const params = route.params as
    | { conversationId: number; otherPartyName: string; listingTitle: string }
    | { listingId: number; listingTitle: string; otherPartyName?: string };

  const [conversationId, setConversationId] = useState<number | null>(
    'conversationId' in params ? params.conversationId : null
  );
  const listingId = 'listingId' in params ? params.listingId : null;
  const [items, setItems] = useState<Message[]>([]);
  const [body, setBody] = useState('');
  const [sending, setSending] = useState(false);
  const [loading, setLoading] = useState(true);

  const load = useCallback(async () => {
    try {
      if (conversationId) {
        const page = await messagesApi.listMessages(conversationId);
        setItems(page.messages);
        await messagesApi.markRead(conversationId);
      } else if (listingId) {
        const { conversation } = await messagesApi.getThread(listingId);
        if (conversation) {
          setConversationId(conversation.id);
          setItems(conversation.messages);
        }
      }
    } catch (err) {
      Alert.alert('Could not load messages', err instanceof ApiError ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  }, [conversationId, listingId]);

  useEffect(() => {
    load();
  }, [load]);

  const send = async () => {
    const text = body.trim();
    if (!text) return;
    setSending(true);
    setBody('');
    try {
      const { conversation } = conversationId
        ? await messagesApi.reply(conversationId, text)
        : await messagesApi.sendBuyerMessage(listingId!, text);
      setConversationId(conversation.id);
      setItems(conversation.messages);
    } catch (err) {
      Alert.alert('Could not send', err instanceof ApiError ? err.message : String(err));
      setBody(text);
    } finally {
      setSending(false);
    }
  };

  return (
    <KeyboardAvoidingView style={styles.container} behavior={Platform.OS === 'ios' ? 'padding' : undefined}>
      <View style={styles.header}>
        <Text style={styles.back} onPress={() => nav.goBack()}>
          ← Back
        </Text>
        <View style={{ flex: 1 }}>
          <Text style={styles.title} numberOfLines={1}>{params.otherPartyName || 'Chat'}</Text>
          <Text style={styles.subtitle} numberOfLines={1}>{params.listingTitle}</Text>
        </View>
      </View>

      <FlatList
        data={items}
        keyExtractor={(m) => String(m.id)}
        contentContainerStyle={styles.list}
        ListEmptyComponent={!loading ? <Text style={styles.empty}>Say hello →</Text> : null}
        renderItem={({ item }) => {
          const mine = item.senderId === user?.id;
          return (
            <View style={[styles.bubble, mine ? styles.mine : styles.theirs]}>
              <Text style={[styles.bubbleText, mine && styles.bubbleTextMine]}>{item.text}</Text>
            </View>
          );
        }}
      />

      <View style={styles.composer}>
        <TextInput
          style={styles.input}
          value={body}
          onChangeText={setBody}
          placeholder="Message…"
          placeholderTextColor={colors.neutral700}
          multiline
        />
        <Pressable onPress={send} disabled={sending} style={styles.sendButton}>
          <Text style={styles.sendLabel}>Send</Text>
        </Pressable>
      </View>
    </KeyboardAvoidingView>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: colors.bg },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.md,
    paddingTop: spacing.xl,
    paddingHorizontal: spacing.lg,
    paddingBottom: spacing.md,
  },
  back: { fontFamily: fonts.bodyMedium, fontSize: 13, color: colors.accent },
  title: { fontFamily: fonts.headingBold, fontSize: 16, color: colors.text },
  subtitle: { fontFamily: fonts.body, fontSize: 11, color: colors.text, opacity: 0.6 },
  list: { padding: spacing.lg, gap: 8 },
  bubble: { maxWidth: '80%', paddingVertical: 8, paddingHorizontal: 12, borderWidth: 2, borderColor: colors.text },
  mine: { alignSelf: 'flex-end', backgroundColor: colors.text },
  theirs: { alignSelf: 'flex-start', backgroundColor: colors.bg },
  bubbleText: { fontFamily: fonts.body, fontSize: 14, color: colors.text },
  bubbleTextMine: { color: colors.bg },
  empty: { fontFamily: fonts.body, fontSize: 13, color: colors.text, opacity: 0.6, textAlign: 'center', marginTop: spacing.xxl },
  composer: {
    flexDirection: 'row',
    alignItems: 'flex-end',
    gap: spacing.sm,
    padding: spacing.md,
    borderTopWidth: 2,
    borderTopColor: colors.text,
  },
  input: {
    flex: 1,
    borderWidth: 2,
    borderColor: colors.text,
    paddingVertical: 10,
    paddingHorizontal: 12,
    fontFamily: fonts.body,
    fontSize: 14,
    color: colors.text,
    maxHeight: 100,
  },
  sendButton: { backgroundColor: colors.accent, paddingVertical: 12, paddingHorizontal: 16 },
  sendLabel: { fontFamily: fonts.headingBold, fontSize: 13, color: colors.bg },
});
