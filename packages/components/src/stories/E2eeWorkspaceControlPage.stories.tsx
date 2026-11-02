import removalVector from '../../../e2ee-core/test/ledger-v1-vector.json';
import type { Meta, StoryObj } from '@storybook/react';
import { fn } from 'storybook/test';
import { E2eeWorkspaceControlPage } from '@/components/pages/e2ee-workspace-control-page';
import { appendLedgerHistory } from '@/lib/e2ee-ledger-history';

// Synthetic signed protocol fixture. No user history or private device key.
const genesisHash = '18cb6fa187326e2f18402cba33ef7f316b8a71b0e1d026da9b79c60f6b7055de';
const page = {
  workspaceId: 'synthetic-workspace',
  genesisHash,
  checkpoint: { headHash: genesisHash, length: 1 },
  startIndex: 0,
  position: 'p1:synthetic-workspace:1:offset:0',
  nextCursor: null,
  recordsHex: [
    '82860158208a88e3dd7409f195fd52db2d3cba5d72ca6709bf1d94121bf3748801b40f6f5c58200202020202020202020202020202020202020202020202020202020202020202500303030303030303030303030303030358200404040404040404040404040404040404040404040404040404040404040404582005050505050505050505050505050505050505050505050505050505050505055840116dc6d18360ac4d1020a255f4c4589f2bd533b045db20794f431079f298523ab37223a4d861f55ca506abb41876e2aefada1ee6931e9ca7e89c6a6235901a03',
  ],
};
const meta = {
  title: 'Pages/EncryptedWorkspace',
  component: E2eeWorkspaceControlPage,
  parameters: { layout: 'fullscreen' },
  args: {
    workspaceId: page.workspaceId,
    genesisHash,
    history: null,
    loading: false,
    failure: null,
    diagnostics: () => '{}',
    onRepairLocal: () => {},
    onResetProgress: () => {},
    onLoadMore: fn(),
    onRefresh: fn(),
    onBack: fn(),
  },
} satisfies Meta<typeof E2eeWorkspaceControlPage>;
export default meta;
type Story = StoryObj<typeof meta>;
export const Loading: Story = { args: { loading: true } };
export const Failed: Story = {
  args: { failure: { kind: 'server', code: 'bad-signature', position: 1 } },
};
export const DesktopApprovalRequired: Story = {
  args: { failure: { kind: 'approval-required', code: 'approval-required' } },
};
export const ApprovedDevice: Story = { args: { onOpen: fn() } };
export const ProgressConflict: Story = {
  args: { failure: { kind: 'progress-conflict', code: 'rolled-back' } },
};
export const IdentityConflict: Story = {
  args: { failure: { kind: 'identity-conflict', code: 'pin-mismatch' } },
};
export const Unsupported: Story = { args: { unavailable: true } };
export const VerifiedLocalGenesis: Story = {
  args: {
    history: appendLedgerHistory(null, page, {
      workspaceId: page.workspaceId,
      genesisHash,
      localPin: genesisHash,
    }),
  },
};
export const UnconfirmedGenesis: Story = {
  args: {
    history: appendLedgerHistory(null, page, {
      workspaceId: page.workspaceId,
      genesisHash,
      localPin: null,
    }),
  },
};

// Synthetic multi-operation ledger: the frozen ledger v1 compatibility vector
// (packages/e2ee-core/test/ledger-v1-vector.json), signed by fixed test keys.
const vectorGenesis = 'abbdb8c86c0d3715ede2b023592e6caa5ea4fe02d8127177f3a179d19ec96508';
const vectorPage = {
  workspaceId: 'synthetic-team-workspace',
  genesisHash: vectorGenesis,
  checkpoint: {
    headHash: '678d8a5fc4bb2ab0ef21032aa8d060056057958f15729fc53569158d07f5c0ce',
    length: 10,
  },
  startIndex: 0,
  position: 'p1:synthetic-workspace:10:offset:0',
  nextCursor: null,
  recordsHex: [
    '82860158208a88e3dd7409f195fd52db2d3cba5d72ca6709bf1d94121bf3748801b40f6f5c58200a0a0a0a0a0a0a0a0a0a0a0a0a0a0a0a0a0a0a0a0a0a0a0a0a0a0a0a0a0a0a0a500a0a0a0a0a0a0a0a0a0a0a0a0a0a0a0a582065656565656565656565656565656565656565656565656565656565656565655820141414141414141414141414141414141414141414141414141414141414141458400c6bf6fb035a2a65f540554393cc6321949c72702730b1be56dfdf3d349538e59a907cd8977071811144de355eb9976dbb69e67366d4f0dcc71d9b9321f70d07',
    '82835820abbdb8c86c0d3715ede2b023592e6caa5ea4fe02d8127177f3a179d19ec9650858208a88e3dd7409f195fd52db2d3cba5d72ca6709bf1d94121bf3748801b40f6f5c8301500b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b8650020202020202020202020202020202025820020202020202020202020202020202020202020202020202020202020202020258208139770ea87d175f56a35466c34c7ecccb8d8a91b4ee37a25df60f5b8fc9b39458206666666666666666666666666666666666666666666666666666666666666666f65840a18665489d42e5dd6fc43474cb9f9de26b33d103f3e3a0287fa94e3786ba30ef39debf2ad8cf0903a6a24a7d1e9ba56abb15ff0b7c2eed29d7d45fc9e5494f09584030a62305c11d675b10924f75538fb1ba926477418b66f404fa72d0d4d4ccceb3c7333c3f160d24f2f3db3532874cf448b60af855b734c02797314b17e5202306',
    '82835820925d3705fa0211d988383070703f3fb658a8e02afe2e997ab472c63a54d76bca58208a88e3dd7409f195fd52db2d3cba5d72ca6709bf1d94121bf3748801b40f6f5c8303500b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b01584040c3b08613664cc50241d6b6c5824a0c0320c9944dcca14a09a02b88ba2596462454402bce877e19aaff6bc3ccffcf288bd563b21fd89037f09e1a3af1b64a0b',
    '82835820027ca698933c4a310deeb10de87dc1ee6ee88776a5576a936bda26e84a97bec658208a88e3dd7409f195fd52db2d3cba5d72ca6709bf1d94121bf3748801b40f6f5c8504005820ca93ac1705187071d67b83c7ff0efe8108e8ec4530575d7726879333dbdabe7c582068686868686868686868686868686868686868686868686868686868686868685840cbf8b82c4d1a5419b8ff615d9949248f5a2e353d0da447c5169b64bda82048ce004364c3b38770690c6a75b33b5edc6d0b9195fe70b3a7e59923999dd6a29903584096c29128342df2c17c5d77743528abb3edef7181ac1da505832be16b407517647ef47f64c2b927a188a833bfb9218d60fbd5db9895bbdf468b388432eb981307',
    '828358203157bf9c5b76cda2d05bc7199158b91867b9965a76e3fa51cd7e39b414bb7d8558208139770ea87d175f56a35466c34c7ecccb8d8a91b4ee37a25df60f5b8fc9b3948407015820151515151515151515151515151515151515151515151515151515151515151558483131313131313131313131313131313131313131313131313131313131313131313131313131313131313131313131313131313131313131313131313131313131313131313131315840f977751019c5085a7ab81ac534bcd22b645d590d1400ccdba80d8fe87acdf303110cbbb9a0ed29ba1f0029b5f129715e43913f6316aaa1a1564a172c42ea3c0b',
    '8283582054cc224ab8b6bdcce15dd92850253117a8e36ff7552cb0f6259788045ca310c458208a88e3dd7409f195fd52db2d3cba5d72ca6709bf1d94121bf3748801b40f6f5c82055820ca93ac1705187071d67b83c7ff0efe8108e8ec4530575d7726879333dbdabe7c58406c798cafe3fec6552b6f4119fc88969ff8f23136ca7e7842485cca2ac135d045355d9408f761594039f6f0ed31fb7ea445ddaf80701f7527902330ccca99e001',
    '8283582065910a099ec12f82828d203891206b1d4d4d4068dc5536e7cfe792a1b3ca4eb258208a88e3dd7409f195fd52db2d3cba5d72ca6709bf1d94121bf3748801b40f6f5c8508500b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b02582016161616161616161616161616161616161616161616161616161616161616165848323232323232323232323232323232323232323232323232323232323232323232323232323232323232323232323232323232323232323232323232323232323232323232323232584011218b00155fdbb4d48c2a4793b814b033917c47e814f2b067a1c86bdc3f0d3beb312dabbffc8e2dfd3f4cac821fe3293e6ead9191ee3f58eafb7e2888791707',
    '82835820fcb3ee7baed8a270b0dfe0e85da10bd98f3283dcb2242293298175efef513bb858208a88e3dd7409f195fd52db2d3cba5d72ca6709bf1d94121bf3748801b40f6f5c8301500c0c0c0c0c0c0c0c0c0c0c0c0c0c0c0c865003030303030303030303030303030303582003030303030303030303030303030303030303030303030303030303030303035820ed4928c628d1c2c6eae90338905995612959273a5c63f93636c14614ac8737d158206767676767676767676767676767676767676767676767676767676767676767f658401907a8070f9a18e83ecfa5bf02dd4b3e3077f1c715efc671609d3e1d7898a81a26e56d1cdb9d8aa6f84156c76cb00b4560f1be970df3ce31810cde31a3aa350b584040fe474e86ecfdb46be8b8eebad3af323fb3c9cf19a51f94675ba36ce6dc7045b59dd74b730e64cef1ef450dc7458c9f96b01ed25e6ae5d2f12a819e8dcad00e',
    '82835820cdbec1135ea8a6027f650b39b8493d2027aaae518815a5569950940dc8642b5258208a88e3dd7409f195fd52db2d3cba5d72ca6709bf1d94121bf3748801b40f6f5c8206500c0c0c0c0c0c0c0c0c0c0c0c0c0c0c0c5840efc2fbba24c180d5d3026762cbcd825ac2be23f9de8775616352fae08c59f5dfbfd489eb2b5ea599ba98bcc3778ee530cfd8c389638d9abad7bda30d652d3a09',
    '82835820e7fe1ef3dfaa4e1001fd1a4df3a1af79f6c5d6cbc72b11502372b6030b8136685820ed4928c628d1c2c6eae90338905995612959273a5c63f93636c14614ac8737d1820981015840434eaaf0404d7c6e560b33dc0a086de1e689da4d42598385e1b2878b555e6f9b3388612b787aa24b26a9f944951150cd494711577b6bdcd63f040a19ef260900',
  ],
};
const vectorHistory = (recorded: typeof vectorPage) =>
  appendLedgerHistory(null, recorded, {
    workspaceId: vectorPage.workspaceId,
    genesisHash: vectorGenesis,
    localPin: vectorGenesis,
  });
// Synthetic profiles keyed by the vector's crypto user IDs, never account authority.
const teamProfiles = {
  memberProfiles: new Map([
    ['0a'.repeat(32), { name: 'Alex Chen' }],
    ['03'.repeat(32), { name: 'Jordan Lee' }],
  ]),
};
// The first nine records: everything this client can verify.
export const TeamHistory: Story = {
  args: {
    workspaceId: vectorPage.workspaceId,
    genesisHash: vectorGenesis,
    ...teamProfiles,
    history: vectorHistory({
      ...vectorPage,
      checkpoint: {
        headHash: 'e7fe1ef3dfaa4e1001fd1a4df3a1af79f6c5d6cbc72b11502372b6030b813668',
        length: 9,
      },
      recordsHex: vectorPage.recordsHex.slice(0, 9),
    }),
  },
};
// The final vector record declares unsupported capability 2.
export const UpgradeRequired: Story = {
  args: {
    workspaceId: vectorPage.workspaceId,
    genesisHash: vectorGenesis,
    ...teamProfiles,
    history: appendLedgerHistory(
      null,
      {
        ...vectorPage,
        genesisHash: removalVector.anchor,
        checkpoint: {
          headHash: removalVector.records.at(-1)!.hash,
          length: removalVector.records.length,
        },
        recordsHex: removalVector.records.map((record) => record.hex),
      },
      {
        workspaceId: vectorPage.workspaceId,
        genesisHash: removalVector.anchor,
        localPin: removalVector.anchor,
      }
    ),
  },
};

// Real signed fixture before removals; the native callbacks are synthetic in this preview.
const memberPage = {
  workspaceId: 'synthetic-workspace',
  genesisHash: removalVector.anchor,
  checkpoint: { headHash: removalVector.records[1]!.hash, length: 2 },
  startIndex: 0,
  position: 'p1:synthetic-workspace:2:offset:0',
  nextCursor: null,
  recordsHex: removalVector.records.slice(0, 2).map((record) => record.hex),
};
export const OwnerMemberControls: Story = {
  args: {
    workspaceId: memberPage.workspaceId,
    genesisHash: memberPage.genesisHash,
    history: appendLedgerHistory(null, memberPage, {
      workspaceId: memberPage.workspaceId,
      genesisHash: memberPage.genesisHash,
      localPin: memberPage.genesisHash,
    }),
    memberProfiles: new Map([
      ['0a'.repeat(32), { name: 'Alex Chen' }],
      ['02'.repeat(32), { name: 'Jordan Lee' }],
    ]),
    memberManagement: { actorRole: 'owner', remove: fn(), setRole: fn() },
  },
};

export const CustodyLocked: Story = {
  args: { failure: { kind: 'custody-locked', code: 'locked' } },
};
export const CustodyIndeterminate: Story = {
  args: { failure: { kind: 'custody-indeterminate', code: 'indeterminate' } },
};
