import { ActivityIndicator, View } from 'react-native';
import { NavigationContainer } from '@react-navigation/native';
import { createNativeStackNavigator } from '@react-navigation/native-stack';
import { ParentosTabs } from './ParentosTabs';
import { UusikiTabs } from './UusikiTabs';
import { ThreadScreen } from '../screens/ThreadScreen';
import { AuthGate } from '../screens/AuthGate';
import { useAuth } from '../state/AuthContext';
import { colors } from '../theme';
import { navigationRef } from './ref';
import type { RootStackParamList } from './types';

const Stack = createNativeStackNavigator<RootStackParamList>();

export function RootNavigator() {
  const { user, loading } = useAuth();

  if (loading) {
    return (
      <View style={{ flex: 1, backgroundColor: colors.bg, alignItems: 'center', justifyContent: 'center' }}>
        <ActivityIndicator color={colors.accent} />
      </View>
    );
  }

  return (
    <NavigationContainer ref={navigationRef}>
      {user ? (
        <Stack.Navigator screenOptions={{ headerShown: false }}>
          {/* ParentOS is the landing shell; Uusiki is reached from Home's
              card and left again via each Uusiki tab's "← ParentOS" link. */}
          <Stack.Screen name="ParentosTabs" component={ParentosTabs} />
          <Stack.Screen name="UusikiShell" component={UusikiTabs} />
          <Stack.Screen name="Thread" component={ThreadScreen} />
        </Stack.Navigator>
      ) : (
        <AuthGate />
      )}
    </NavigationContainer>
  );
}
