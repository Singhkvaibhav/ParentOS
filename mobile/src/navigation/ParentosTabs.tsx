import { createBottomTabNavigator } from '@react-navigation/bottom-tabs';
import { Text } from 'react-native';
import { HomeScreen } from '../screens/HomeScreen';
import { AccountScreen } from '../screens/AccountScreen';
import { colors, fonts } from '../theme';
import type { ParentosTabParamList } from './types';

const Tab = createBottomTabNavigator<ParentosTabParamList>();

const ICON: Record<keyof ParentosTabParamList, string> = {
  Home: '⌂',
  Account: '◑',
};

export function ParentosTabs() {
  return (
    <Tab.Navigator
      screenOptions={({ route }) => ({
        headerShown: false,
        tabBarActiveTintColor: colors.accent,
        tabBarInactiveTintColor: colors.text,
        tabBarStyle: { backgroundColor: colors.bg, borderTopWidth: 2, borderTopColor: colors.text },
        tabBarLabelStyle: { fontFamily: fonts.bodyMedium, fontSize: 10 },
        tabBarIcon: ({ color }) => <Text style={{ color, fontSize: 16 }}>{ICON[route.name as keyof ParentosTabParamList]}</Text>,
      })}
    >
      <Tab.Screen name="Home" component={HomeScreen} />
      <Tab.Screen name="Account" component={AccountScreen} />
    </Tab.Navigator>
  );
}
