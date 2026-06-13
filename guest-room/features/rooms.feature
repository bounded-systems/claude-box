# Executed against guest-room/mod.ts by guest-room.test.ts.
# A room is a named bundle of adjoining doors — like a hotel suite, opening a
# fixed set of connecting doors for a kind of stay.

Feature: A room is a named bundle of adjoining doors

  Scenario: the dev room opens keeper, net and scout
    Given the hotel's door catalog and rooms
    When the room "dev" is opened
    Then the open doors are "keeper, net, scout"

  Scenario: the read room opens only scout
    Given the hotel's door catalog and rooms
    When the room "read" is opened
    Then the open doors are "scout"

  Scenario: an unknown room is refused, never a silent empty stay
    Given the hotel's door catalog and rooms
    When the room "penthouse" is opened
    Then opening is refused
