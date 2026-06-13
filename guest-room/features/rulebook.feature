# Executed against guest-room/mod.ts by guest-room.test.ts.
# The room hands its guest a rulebook keyed to exactly the doors present: a
# how-to card per granted door, and a "no rule" card per absent one. The surface
# is honest — it states what is denied, not only what is granted.

Feature: The room hands the guest a rulebook of exactly its doors

  Scenario: granted doors are rendered as how-to cards
    Given the hotel's door catalog and rooms
    When the room "read" is opened
    Then the rulebook grants mention "scout"

  Scenario: ungranted doors are explicitly denied
    Given the hotel's door catalog and rooms
    When the room "read" is opened
    Then the rulebook denies "keeper"
    And the rulebook denies "net"

  Scenario: an escape hatch can suppress a single denial
    Given the hotel's door catalog and rooms
    When the room "read" is opened with "net" suppressed
    Then the rulebook denies "keeper"
    And the rulebook does not deny "net"
