import { Given, Then, When } from '@cucumber/cucumber';
import type { LodyWorld } from '../support/world.js';

Given(
  'the user has entered an isolated local workspace with two synthetic Git projects',
  async function (this: LodyWorld) {
    await this.configureProjectReopenJourney();
  }
);

When(
  'the user adds the first local project through the project picker',
  async function (this: LodyWorld) {
    await this.projectReopenPage!.addFirstProject();
  }
);

When(
  'the user reopens the picker and adds the second local project',
  async function (this: LodyWorld) {
    await this.projectReopenPage!.addSecondProjectAfterReopeningPicker();
  }
);

When(
  'the user switches to the second project and reopens the first from the picker',
  async function (this: LodyWorld) {
    await this.projectReopenPage!.switchToSecondProjectAndReopenFirstFromPicker();
  }
);

When(
  'the user tries to add the first local project folder again',
  async function (this: LodyWorld) {
    await this.projectReopenPage!.tryAddingFirstProjectAgain();
  }
);

Then(
  'the local project catalog keeps one original record for each folder',
  async function (this: LodyWorld) {
    await this.projectReopenPage!.expectCatalogKeepsOriginalRecords();
  }
);

Then(
  'the empty projects stay out of the sidebar but remain selectable in the picker',
  async function (this: LodyWorld) {
    await this.projectReopenPage!.expectEmptyProjectsStayInPicker();
  }
);
