# Agent informational results

Status: draft
Translation: pending

A user can invoke an agent command that processes input without asking a model to
respond. When the agent reports that processing completed, the conversation shows
an informational result rather than a failed turn or invented model response.

Core's existing notice contract identifies the message and its severity. The
adapter may announce completion only after its native command has returned
successfully. A question being answered, a request being accepted, or an empty
model response is not by itself proof of completion.

Lody retains and displays each informational occurrence, including repeated
identical results on different turns. Informational notices use neutral styling.
Existing warning records without a severity retain their warning meaning and
existing repeated-warning suppression. Notice text stays separate from assistant
text and is not used as model-generated prose for titles or prompt replay.

A command error remains an error. A model turn ending without observable output
continues to receive the existing silent-failure handling. This change does not
add a command outcome protocol or change the meaning of ordinary ACP end_turn.

## Evidence and limits

The existing Core LodyNotice contract defines info, warning and error. Real Pi
0.85.1 experiments distinguished handled input, handler failure and empty model
output. Host consumption and original desktop acceptance remain under review;
this draft does not assert completed end-to-end verification.
