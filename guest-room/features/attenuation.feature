# Executed against guest-room/mod.ts by guest-room.test.ts.
# Attenuation narrows a door a room already holds. A caveat is an opaque
# restriction the engine carries and renders, but never interprets — the broker
# behind the door enforces it. Narrowing is append-only, so authority can only
# decrease: a door is handed onward equally or more restricted, never wider.

Feature: A door can be attenuated, never widened

  Scenario: a narrowed door shows its restriction in the rulebook
    Given the hotel's door catalog
    When the room resolves the "net" door
    And the door is narrowed to "host=example.com"
    Then the rulebook card for it shows "host=example.com"
    And the rulebook card for it shows "RESTRICTED"

  Scenario: an unrestricted door reads as the full grant
    Given the hotel's door catalog
    When the room resolves the "net" door
    Then the rulebook card for it does not show "RESTRICTED"

  Scenario: narrowing is append-only — earlier caveats are kept
    Given the hotel's door catalog
    When the room resolves the "scout" door
    And the door is narrowed to "repo=acme/widgets"
    And the door is narrowed to "readonly"
    Then the rulebook card for it shows "repo=acme/widgets"
    And the rulebook card for it shows "readonly"

  Scenario: attenuating by nothing leaves the door unchanged
    Given the hotel's door catalog
    When the room resolves the "net" door
    And the door is narrowed to ""
    Then the rulebook card for it does not show "RESTRICTED"
