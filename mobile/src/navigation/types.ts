// Two tab shells (mirroring the design canvas's "Uusiki marketplace" vs.
// "ParentOS" shells) plus one shared detail screen (Thread) reachable from
// either. Kept as loose `any`-navigation at the call sites that cross
// between shells (see FeedScreen/HomeScreen/AccountScreen) rather than a
// fully composed navigator type — the app has one root stack, so this is a
// pragmatic amount of typing for a scaffold, not a hole in the design.
import type { NavigatorScreenParams } from '@react-navigation/native';

export type UusikiTabParamList = {
  Browse: undefined;
  Search: undefined;
  Sell: undefined;
  Chat: undefined;
  Orders: undefined;
};

export type ParentosTabParamList = {
  Home: undefined;
  Account: undefined;
};

// Thread is reachable two ways, matching the backend's own split (see
// backend/messages/routes.js): from Chat with an existing conversation id,
// or from a listing with no conversation yet - sending the first message
// there creates one (POST /api/v1/messages/thread).
export type RootStackParamList = {
  // NavigatorScreenParams, not `undefined` - lets code with no React
  // context of its own (the notification-tap handler in notifications.ts,
  // which fires from an OS callback) navigate straight to a nested tab,
  // e.g. navigationRef.navigate('UusikiShell', { screen: 'Chat' }).
  ParentosTabs: NavigatorScreenParams<ParentosTabParamList> | undefined;
  UusikiShell: NavigatorScreenParams<UusikiTabParamList> | undefined;
  Thread:
    | { conversationId: number; otherPartyName: string; listingTitle: string }
    | { listingId: number; listingTitle: string; otherPartyName?: string };
};
