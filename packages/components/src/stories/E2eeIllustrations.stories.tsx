import type { Meta, StoryObj } from '@storybook/react';
import {
  E2eeDevicePairArt,
  E2eeMemberWaitingArt,
  E2eeShieldKeyArt,
} from '../components/e2ee/e2ee-illustrations';

function Board() {
  return (
    <div style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: 40, padding: 32 }}>
      <E2eeShieldKeyArt attention />
      <E2eeShieldKeyArt size={40} />
      <E2eeMemberWaitingArt />
      <E2eeDevicePairArt />
      <E2eeDevicePairArt width={196} transferring />
    </div>
  );
}

const meta = {
  title: 'Pages/EncryptedWorkspace/Illustrations',
  component: Board,
} satisfies Meta<typeof Board>;
export default meta;
type Story = StoryObj<typeof meta>;

export const All: Story = {};
