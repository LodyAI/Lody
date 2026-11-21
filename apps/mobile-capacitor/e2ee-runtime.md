# Encrypted workspace runtime

The native app injects `mobilePersonalHost` into the shared router's
`createE2eeRuntime` port. It reuses the authenticated Convex client and shared
`personalEntry` owner, supplies the fixed mobile database namespace and adapts the
existing `LodyKek` plugin. Browser previews do not activate this native factory.
A missing/old/locked plugin reports its explicit protection state; it cannot fall
back to browser custody or ordinary workspace transports.

The phone can now create an encrypted workspace itself. Creation signs the genesis
with this device, keeps the initial epoch key and identity in native custody, binds
the server workspace ID only after the authenticated create response, and writes the
same entry pin/approval originals a reopened device uses. The phone can then approve
a desktop account-pairing request for that workspace through the public portable
approver; the desktop continues its existing join flow.

The original join path remains: the phone can also prepare its device request from
an existing workspace's desktop pairing offer, and the desktop explicitly approves
it. The public host verifies the admission before claiming keys or issuing
content/RPC grants. Opening and refresh retain the same device, ledger, approval
evidence and key journals. No new backend endpoint, configRevision recovery or
public revision is introduced.

The app owns one synchronous factory and retains its real host Scope through
confirmed close. Account changes fence old operations. Incomplete close retains
the full public recovery owner; a UI timeout never releases a native buffer or lock.
Logout and ordinary local-cache cleanup retain identity. Lost protection requires
fresh desktop approval; the replacement-offer recovery UI is not implemented here.

Account-level requester assembly for a new portable device is separate; the phone
uses the approver side. Machine-sharing administration and other capabilities
without a real portable port stay explicitly unsupported; they do not prevent
content and dispatch to an admitted machine owned by this account. Discovery of
another member's shared machine also needs a real portable policy-read port and is
not advertised here.
Public UI and transport capability gates remain responsible for secondary features.

Tests exercise the real portable host, signed genesis creation, signed desktop
admission, IDB stores and native adapter, with synthetic network/OS boundaries.
They are not installed-app acceptance. Simulator verification uses only the
`test-build` profile; stable publication and physical-device first-unlock/hardware
checks are outside its proof.
