import * as Notifications from 'expo-notifications';
import * as Device from 'expo-device';
import Constants from 'expo-constants';
import { Platform } from 'react-native';
import { notifications as notificationsApi } from './api/endpoints';
import { navigationRef } from './navigation/ref';

// Show a banner/sound even while the app is in the foreground - the
// default suppresses this, but "someone messaged you" or "your item sold"
// is exactly the kind of thing worth interrupting for, matching what the
// same event already does over email (see backend/services/
// notificationsService.js, which fires both from one shared call site).
Notifications.setNotificationHandler({
  handleNotification: async () => ({
    shouldShowAlert: true,
    shouldPlaySound: true,
    shouldSetBadge: true,
    shouldShowBanner: true,
    shouldShowList: true,
  }),
});

// Set once a token is successfully obtained, so logout can unregister the
// exact one this device is holding without a separate lookup.
let currentToken: string | null = null;

// No-ops safely wherever push can't work: a simulator/emulator has no
// token to get, and without an EAS project id (see app.json / `eas init`)
// Expo has nowhere to route push through. Both are normal, expected states
// during development, not errors - logged at most, never thrown, since a
// user should never be blocked from using the app because push couldn't
// be wired up on this particular device.
export async function registerForPushNotifications(): Promise<void> {
  if (!Device.isDevice) return;

  const { status: existingStatus } = await Notifications.getPermissionsAsync();
  let status = existingStatus;
  if (status !== 'granted') {
    ({ status } = await Notifications.requestPermissionsAsync());
  }
  if (status !== 'granted') return;

  if (Platform.OS === 'android') {
    await Notifications.setNotificationChannelAsync('default', {
      name: 'default',
      importance: Notifications.AndroidImportance.DEFAULT,
    });
  }

  const projectId = Constants.expoConfig?.extra?.eas?.projectId;
  if (!projectId) {
    console.warn('[push] No EAS project id configured (run `eas init`) - skipping push registration.');
    return;
  }

  try {
    const { data: token } = await Notifications.getExpoPushTokenAsync({ projectId });
    currentToken = token;
    await notificationsApi.registerPushToken(token, Platform.OS === 'ios' ? 'ios' : 'android');
  } catch (e) {
    console.warn('[push] Could not register for push notifications:', e);
  }
}

// Called from logout (see AuthContext) - a signed-out device shouldn't go
// on receiving another account's notifications on its next sign-in either,
// so this both tells the backend to forget the token AND clears the local
// copy rather than just one of the two.
export async function unregisterPushNotifications(): Promise<void> {
  if (!currentToken) return;
  const token = currentToken;
  currentToken = null;
  try {
    await notificationsApi.unregisterPushToken(token);
  } catch (e) {
    console.warn('[push] Could not unregister push token:', e);
  }
}

// Routes a tapped notification to the relevant tab - not the exact
// sub-screen (e.g. one specific conversation), since the push payload
// carries only ids (see the `data` shape in notificationsService.js's
// create()), not the display strings ThreadScreen's route params require.
// Landing on the tab and letting the person pick from there is the
// standard, low-risk version of this rather than threading placeholder
// strings through just to reach one screen deeper.
export function routeForNotificationType(type: string | undefined): { screen: 'UusikiShell'; params: { screen: 'Chat' | 'Orders' } } | null {
  switch (type) {
    case 'message_received':
      return { screen: 'UusikiShell', params: { screen: 'Chat' } };
    case 'item_sold':
    case 'purchase_confirmed':
      return { screen: 'UusikiShell', params: { screen: 'Orders' } };
    default:
      // review_received / listing_taken_down have no dedicated screen yet
      // in this app - opening to wherever it already was is honest, not a
      // bug, given that.
      return null;
  }
}

// Installed once from App.tsx. Handles both a tap that arrives while the
// app is already running and one that COLD-STARTS it (the notification
// that launched the app is available synchronously via
// getLastNotificationResponseAsync, not through the listener below, which
// only fires for taps after the listener is attached).
export function configureNotificationRouting() {
  const handleResponse = (response: Notifications.NotificationResponse) => {
    const route = routeForNotificationType(response.notification.request.content.data?.type as string | undefined);
    if (route && navigationRef.isReady()) {
      navigationRef.navigate(route.screen, route.params);
    }
  };

  Notifications.getLastNotificationResponseAsync().then((response) => {
    if (response) handleResponse(response);
  });

  const subscription = Notifications.addNotificationResponseReceivedListener(handleResponse);
  return () => subscription.remove();
}
