import { createBottomTabNavigator } from '@react-navigation/bottom-tabs';
import { Text } from 'react-native';
import { FeedScreen } from '../screens/FeedScreen';
import { SearchScreen } from '../screens/SearchScreen';
import { SellScreen } from '../screens/SellScreen';
import { ChatListScreen } from '../screens/ChatListScreen';
import { OrdersScreen } from '../screens/OrdersScreen';
import { colors, fonts } from '../theme';
import type { UusikiTabParamList } from './types';

const Tab = createBottomTabNavigator<UusikiTabParamList>();

const ICON: Record<keyof UusikiTabParamList, string> = {
  Browse: '⌂',
  Search: '⌕',
  Sell: '+',
  Chat: '✉',
  Orders: '▤',
};

export function UusikiTabs() {
  return (
    <Tab.Navigator
      screenOptions={({ route }) => ({
        headerShown: false,
        tabBarActiveTintColor: colors.accent,
        tabBarInactiveTintColor: colors.text,
        tabBarStyle: { backgroundColor: colors.bg, borderTopWidth: 2, borderTopColor: colors.text },
        tabBarLabelStyle: { fontFamily: fonts.bodyMedium, fontSize: 10 },
        tabBarIcon: ({ color }) => <Text style={{ color, fontSize: 16 }}>{ICON[route.name as keyof UusikiTabParamList]}</Text>,
      })}
    >
      <Tab.Screen name="Browse" component={FeedScreen} />
      <Tab.Screen name="Search" component={SearchScreen} />
      <Tab.Screen name="Sell" component={SellScreen} />
      <Tab.Screen name="Chat" component={ChatListScreen} />
      <Tab.Screen name="Orders" component={OrdersScreen} />
    </Tab.Navigator>
  );
}
