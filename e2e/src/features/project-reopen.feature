# language: en
@lody @essence @P1 @runtime-none @LODY-PROJECT-002
Feature: Reopening local projects preserves their catalog identity

  Scenario: User switches projects and cannot add an existing folder twice
    Given the user has entered an isolated local workspace with two synthetic Git projects
    When the user adds the first local project through the project picker
    And the user reopens the picker and adds the second local project
    And the user switches to the second project from the sidebar and reopens the first from the picker
    And the user tries to add the first local project folder again
    Then the local project catalog keeps one original record for each folder
    And the sidebar and project picker agree on the first selected project
