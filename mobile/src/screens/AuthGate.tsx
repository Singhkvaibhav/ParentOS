import { useState } from 'react';
import { LoginScreen } from './LoginScreen';
import { SignupScreen } from './SignupScreen';
import { VerifyScreen } from './VerifyScreen';

// The signed-out half of the app has no navigator (see RootNavigator) - just
// three plain screens switched by local state, since the flow is strictly
// linear (login OR signup -> verify -> done) and never needs back-stack
// behavior like the authenticated tabs do.
type Mode = { name: 'login' } | { name: 'signup' } | { name: 'verify'; email: string; devCode: string | null };

export function AuthGate() {
  const [mode, setMode] = useState<Mode>({ name: 'login' });

  if (mode.name === 'signup') {
    return (
      <SignupScreen
        onSignedUp={(email, devCode) => setMode({ name: 'verify', email, devCode })}
        onBackToLogin={() => setMode({ name: 'login' })}
      />
    );
  }
  if (mode.name === 'verify') {
    return <VerifyScreen email={mode.email} devCode={mode.devCode} onBackToLogin={() => setMode({ name: 'login' })} />;
  }
  return <LoginScreen onCreateAccount={() => setMode({ name: 'signup' })} />;
}
