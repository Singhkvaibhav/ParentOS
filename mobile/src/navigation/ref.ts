import { createNavigationContainerRef } from '@react-navigation/native';
import type { RootStackParamList } from './types';

// A ref to the root NavigationContainer (attached in RootNavigator.tsx),
// so code outside the component tree - specifically the notification-tap
// handler in notifications.ts, which fires from an OS callback with no
// React context of its own - can still navigate.
export const navigationRef = createNavigationContainerRef<RootStackParamList>();
