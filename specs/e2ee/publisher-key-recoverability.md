# Publisher key availability: stage before commit

Status: draft
Translation: current

[中文](publisher-key-recoverability.zh.md)

The former independent-backup options A/B are superseded by the user's selected
[staged publication](atomic-removal.md). Before CAS, an honest publisher durably
retains the protected candidate, original signed record and all post-transition
recipient envelopes, atomically stages the group and checks exact readback.

A crash before CAS resumes those same originals and the same group. A lost ACK
uses P09 exact-byte reconciliation. A conflict invalidates the candidate instead
of installing or re-signing it. Once the record commits, recipients can obtain
the staged envelopes without the publisher's disk, even if it is permanently lost.
This removes the honest-client committed-but-not-yet-distributed window without
a transaction between Convex and Streams.

Availability still requires the staging service to retain/deliver the acknowledged
originals and the publisher to create usable envelopes. Direct CAS without staging
is a measured malicious-manager withholding case. Only a genuine different
commitment occupying that same epoch authorizes the honest client's cleanup.
The adapter independently restricts deletion to R's original signing device;
account membership or another manager's occupied claim cannot delete its group.
A malicious publisher deleting its own group remains a key-withholding limitation. Later joiners use ordinary
mailbox/repair. No global freshness or anti-withholding proof is inferred from AEAD.

Restricted A remains installed-key host protection, not a vault or identity
recovery mechanism. This choice does not introduce emergency removal exceptions,
new account backdoors, vault wrapping/retention, or strict B. The revised Spec
remains draft for review; production protector and private product activation
have their own acceptance requirements.
