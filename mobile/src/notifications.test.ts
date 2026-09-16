import { routeForNotificationType } from './notifications';

// Pure routing logic, tested directly rather than through the OS-level
// notification-tap plumbing around it (expo-notifications, the navigation
// ref) - that plumbing has nothing to unit-test on its own, and mocking it
// just to reach this switch statement would test the mocks more than the
// actual decision being made.
describe('routeForNotificationType', () => {
  test('a new message routes to the Chat tab', () => {
    expect(routeForNotificationType('message_received')).toEqual({
      screen: 'UusikiShell',
      params: { screen: 'Chat' },
    });
  });

  test('a sale routes the seller to the Orders tab', () => {
    expect(routeForNotificationType('item_sold')).toEqual({
      screen: 'UusikiShell',
      params: { screen: 'Orders' },
    });
  });

  test('a confirmed purchase routes the buyer to the Orders tab', () => {
    expect(routeForNotificationType('purchase_confirmed')).toEqual({
      screen: 'UusikiShell',
      params: { screen: 'Orders' },
    });
  });

  test('a type with no dedicated screen yet (review, takedown) routes nowhere - stays on the current screen', () => {
    expect(routeForNotificationType('review_received')).toBeNull();
    expect(routeForNotificationType('listing_taken_down')).toBeNull();
  });

  test('an unknown or missing type is handled the same as "no route" rather than throwing', () => {
    expect(routeForNotificationType(undefined)).toBeNull();
    expect(routeForNotificationType('something_a_future_backend_change_invents')).toBeNull();
  });
});
