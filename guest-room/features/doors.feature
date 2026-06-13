# Executed against guest-room/mod.ts by guest-room.test.ts.
# A door is the room's unit of authority: the room holds the door (a socket),
# never the daemon's keys behind it.

Feature: A door is the room's unit of authority

  Scenario: a catalogued door resolves to its canonical socket and env
    Given the hotel's door catalog
    When the room resolves the "keeper" door
    Then its in-room socket is "/run/keeperd.sock"
    And the room reaches it via the "KEEPERD_SOCK" env var

  Scenario: an unlisted service still attaches as a generic door
    Given the hotel's door catalog
    When the room resolves the "dolt" door
    Then its in-room socket is "/run/dolt.sock"
    And the room reaches it via the "DOLT_SOCK" env var

  Scenario: a path-unsafe door name is refused, not mounted
    Given the hotel's door catalog
    When the room resolves the "../escape" door
    Then resolution is refused
