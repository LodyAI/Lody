# Changelog

## [0.115.1](https://github.com/LodyAI/Lody/compare/lody-cli-v0.115.0...lody-cli-v0.115.1) (2026-11-23)


### Documentation

* **cli:** add Stable 0.115.1 changelog entry ([8bcf752](https://github.com/LodyAI/Lody/commit/8bcf752e48dc944fc6ddcdec5c51dc79a2f574ec))

## [0.115.0](https://github.com/LodyAI/Lody/compare/lody-cli-v0.114.1...lody-cli-v0.115.0) (2026-11-23)


### Features

* [risk:high] enable E2EE GitHub integration ([#3221](https://github.com/LodyAI/Lody/issues/3221)) ([58d150a](https://github.com/LodyAI/Lody/commit/58d150a785a9022888d7ea874e6871d602eedd0c))
* [risk:high] enable E2EE push, live activity and inbox clients ([#3224](https://github.com/LodyAI/Lody/issues/3224)) ([4477241](https://github.com/LodyAI/Lody/commit/4477241aaa8eddc1fed2bacf736793aad8f08a54))
* [risk:high] migrate OSS snapshots into encrypted workspaces ([#3222](https://github.com/LodyAI/Lody/issues/3222)) ([9ebc37b](https://github.com/LodyAI/Lody/commit/9ebc37b6023ca3441d00be7cb7c6114fc220ca6c))
* [risk:high] support machine-owned encrypted Roost history ([#3215](https://github.com/LodyAI/Lody/issues/3215)) ([f5c6473](https://github.com/LodyAI/Lody/commit/f5c64737cc7b929aaf917e9b4d549ec0086d4368))
* [risk:medium] enable E2EE usage and transfer billing advice ([#3216](https://github.com/LodyAI/Lody/issues/3216)) ([6ffccfb](https://github.com/LodyAI/Lody/commit/6ffccfbae729c0adcddef98d920331aa35a035d4))


### Bug Fixes

* [risk:medium] address E2EE GA setup and disclosure gaps ([#3207](https://github.com/LodyAI/Lody/issues/3207)) ([59c9bd7](https://github.com/LodyAI/Lody/commit/59c9bd752df17ff79ae8e559d82143199ddc2c7e))
* **cli:** restore Claude quota refresh through proxies ([#3242](https://github.com/LodyAI/Lody/issues/3242)) ([8dde1e7](https://github.com/LodyAI/Lody/commit/8dde1e77b0fb25e6258b27cee313041fb858309e))
* make Auto delivery act only on evidence it can trust ([#3208](https://github.com/LodyAI/Lody/issues/3208)) ([f4acbfb](https://github.com/LodyAI/Lody/commit/f4acbfb355ef87bc5b038a2b23d7451af1099c92))
* scope model-dependent ACP config per model and confirm local Flock reads ([#3218](https://github.com/LodyAI/Lody/issues/3218)) ([8d3ba52](https://github.com/LodyAI/Lody/commit/8d3ba5224520bbf3f1c5d95dd9075678d98c0793))

## [0.114.1](https://github.com/LodyAI/Lody/compare/lody-cli-v0.114.0...lody-cli-v0.114.1) (2026-11-23)


### Chores

* **lody-cli:** Synchronize lody-clients versions

## [0.114.0](https://github.com/LodyAI/Lody/compare/efd385764538ae7d447f30a021737cbf22712a35...lody-cli-v0.114.0) (2026-11-23)

### Features

- add the experimental Today daily outline with inline conversation mentions ([#2982](https://github.com/LodyAI/Lody/issues/2982)) ([b3a5587](https://github.com/LodyAI/Lody/commit/b3a5587792b54d58386ce79ca957101cf29a94a2))
- **cli:** let Session editors manage automations on shared machines [risk:high] ([#3059](https://github.com/LodyAI/Lody/issues/3059)) ([fe365ab](https://github.com/LodyAI/Lody/commit/fe365abd3d542122b349ad361f874d6e68335de6))
- **cli:** Lody MCP action tools and Session PR link actions (30 -&gt; 21 tools) ([#3026](https://github.com/LodyAI/Lody/issues/3026)) ([c55f7f6](https://github.com/LodyAI/Lody/commit/c55f7f67682e818b8d939566755eeb18a163b80d))
- **cli:** run long commands under Lody and resume the Session on exit ([#3013](https://github.com/LodyAI/Lody/issues/3013)) ([dacbabb](https://github.com/LodyAI/Lody/commit/dacbabb0f77e4dca35bc7583156d7cc77f433b71))
- **cli:** slim the Lody MCP tool surface (40 -&gt; 30 tools) ([#3022](https://github.com/LodyAI/Lody/issues/3022)) ([75b26ce](https://github.com/LodyAI/Lody/commit/75b26ce0f6d2ff791d3c04cce5864af878b92ce4))
- **cli:** workspace bundle export and import ([#2904](https://github.com/LodyAI/Lody/issues/2904)) ([2b629fa](https://github.com/LodyAI/Lody/commit/2b629fa26dda7b8ca59dc43d41f8066935548c52))
- **components:** draw the Lody Agent harness surface in StyleX ([#2903](https://github.com/LodyAI/Lody/issues/2903)) ([effc96a](https://github.com/LodyAI/Lody/commit/effc96ab2b66dc38ba97ea10f953de7c7ccab74b))
- **components:** make text unselectable by default outside reading surfaces ([#3076](https://github.com/LodyAI/Lody/issues/3076)) ([acda568](https://github.com/LodyAI/Lody/commit/acda5687460232f0e3b300bf043be604874f5291))
- **components:** make the Lody Agent settings real ([#3105](https://github.com/LodyAI/Lody/issues/3105)) ([90c01bf](https://github.com/LodyAI/Lody/commit/90c01bf0fd2cc118537f22dad6109401a6dbba0e))
- continue Turns interrupted by a restart with one continue input ([#2916](https://github.com/LodyAI/Lody/issues/2916)) ([c01933f](https://github.com/LodyAI/Lody/commit/c01933f9ae0b1d1b5e469be7c15fce09ec5a0118))
- explicit pull-request links for a Session (shim report, manual link/unlink) ([#3025](https://github.com/LodyAI/Lody/issues/3025)) ([60c7bf5](https://github.com/LodyAI/Lody/commit/60c7bf5701586406af12b08c6c1546c9092dc430))
- gate workspace Streams WebSocket options behind explicit opt-in ([986f0cf](https://github.com/LodyAI/Lody/commit/986f0cff90324d6a18c0fb342afd07872daabf2a))
- hand a Session's pull request to Auto delivery ([#3014](https://github.com/LodyAI/Lody/issues/3014)) ([f252323](https://github.com/LodyAI/Lody/commit/f252323c74ab7b4ad5446f74337a9f1ae09dead9))
- **memory:** add EverMe as an account-scoped memory provider ([22fc6a8](https://github.com/LodyAI/Lody/commit/22fc6a8998ae7eaae589fbf6d9c23a8a6e50a57d))
- **memory:** add EverMe for shared memory across agents ([e0bb4b0](https://github.com/LodyAI/Lody/commit/e0bb4b0ec3f349c38728b1128996bdccd03e7d48))
- migrate cloud CLI and Electron packaging into public workspace ([#3031](https://github.com/LodyAI/Lody/issues/3031)) ([ddaec32](https://github.com/LodyAI/Lody/commit/ddaec32140388479bb0a486eeb29c64a33d708e5))
- **notifications:** [risk:high] skip mobile push while a desktop is focused ([71c0b7c](https://github.com/LodyAI/Lody/commit/71c0b7c6c451184ed3cce370cefbaa4000097440))
- opt in workspace Streams WebSockets and permit mobile WSS ([2208695](https://github.com/LodyAI/Lody/commit/22086955c4779d94bb197fe0ed128f06c2bbe969))
- support Codex Ultrafast speed tier dropdown ([#2979](https://github.com/LodyAI/Lody/issues/2979)) ([b45836e](https://github.com/LodyAI/Lody/commit/b45836efa10f0e7ca87854cc0371aed04b4dd2fd))
- support remote Antigravity sign-in in Lody ([#3019](https://github.com/LodyAI/Lody/issues/3019)) ([60fd939](https://github.com/LodyAI/Lody/commit/60fd9392aaedfa18d60d3aed2615d0c69dfb6d13))
- toggle the iOS simulator software keyboard from previews [risk:medium] ([#2885](https://github.com/LodyAI/Lody/issues/2885)) ([b112991](https://github.com/LodyAI/Lody/commit/b112991e3280783d755a83ea83049ecad5299575))

### Bug Fixes

- [risk:high] encrypted remote control, shared-member RPC and CLI E2EE client ([#3169](https://github.com/LodyAI/Lody/issues/3169)) ([0700db1](https://github.com/LodyAI/Lody/commit/0700db1d7322eb77a9674f1541b8d4b3bff4511d))
- [risk:high] repair recovery UI and E2EE RPC boundaries ([#3163](https://github.com/LodyAI/Lody/issues/3163)) ([611c776](https://github.com/LodyAI/Lody/commit/611c776bf1406284254170e402663e5c98a70b7b))
- accept any Magpie model metadata in the catalog ([#2954](https://github.com/LodyAI/Lody/issues/2954)) ([eef73dc](https://github.com/LodyAI/Lody/commit/eef73dc10b8858ea9aa3d4d29359846e2d84b230))
- accept Magpie vendor reasoning effort words in model catalog ([4f00812](https://github.com/LodyAI/Lody/commit/4f00812b01c58afc1e19495c3b6c322047ccf81e))
- advance catalog test clocks per waiter ([#3007](https://github.com/LodyAI/Lody/issues/3007)) ([817a9e6](https://github.com/LodyAI/Lody/commit/817a9e612342080ea49ce4af7d843c3e87988faa))
- **automations:** index ledger queries, batch poller demand, converge durable denials ([#3057](https://github.com/LodyAI/Lody/issues/3057)) ([925399c](https://github.com/LodyAI/Lody/commit/925399ca765081dc213032eec7d75e7849880395))
- **ci:** add repository.url for npm provenance and tolerate GitHub jobs API total_count drift ([#3058](https://github.com/LodyAI/Lody/issues/3058)) ([0c06d78](https://github.com/LodyAI/Lody/commit/0c06d783d18d989b8737f36ca84ebf0faeb11034))
- **ci:** read candidate.ossSha for LODY_SOURCE_SHA and raise CLI bundle heap to 4GB ([#3048](https://github.com/LodyAI/Lody/issues/3048)) ([b9c4e44](https://github.com/LodyAI/Lody/commit/b9c4e44e518016a1f1626670c8bf7ec963be580a))
- **ci:** stabilize test fixtures and check Darwin CLI on PRs ([#3108](https://github.com/LodyAI/Lody/issues/3108)) ([2b2e8cf](https://github.com/LodyAI/Lody/commit/2b2e8cf2cb72c0cb9c1bb58c5616b31602c193b0))
- **cli:** accept null or blank cursor as the first page in session history [risk:medium] ([#3027](https://github.com/LodyAI/Lody/issues/3027)) ([bbed0d8](https://github.com/LodyAI/Lody/commit/bbed0d88bb3aa86a47d39a3bce08ee927b4d98ba))
- **cli:** avoid redundant cloud sync for one-shot commands ([#3103](https://github.com/LodyAI/Lody/issues/3103)) ([8a885f0](https://github.com/LodyAI/Lody/commit/8a885f0c670fc65890f89f94a95f44afc58e47ab))
- **cli:** back off watchdog rejoin of persistently errored Streams rooms [risk:medium] ([#2946](https://github.com/LodyAI/Lody/issues/2946)) ([6e6ba4e](https://github.com/LodyAI/Lody/commit/6e6ba4e72a95231d1ad91adfe47ffc433aff7628))
- **cli:** cut daemon process memory ([#3034](https://github.com/LodyAI/Lody/issues/3034)) ([bcaaf6d](https://github.com/LodyAI/Lody/commit/bcaaf6d66705bae9e544cf92484f730c0dcf7abe))
- **cli:** delete one-shot title and quota ACP sessions ([#3018](https://github.com/LodyAI/Lody/issues/3018)) ([e24158f](https://github.com/LodyAI/Lody/commit/e24158fbc63964aa6f71c211b95cc1992ba83daf))
- **cli:** eliminate same-machine Cloud MCP sync waits and isolate coordinator recovery fibers ([#3050](https://github.com/LodyAI/Lody/issues/3050)) ([b09dfac](https://github.com/LodyAI/Lody/commit/b09dfac902714b4fd1cffe06b5bdd33027092dcf))
- **cli:** inline vendor ../package.json manifest reads in bundled chunks ([#3073](https://github.com/LodyAI/Lody/issues/3073)) ([c433137](https://github.com/LodyAI/Lody/commit/c43313746ce1c09d5540ec9df824be220e1acd72))
- **cli:** narrow automation usage guidance ([#3037](https://github.com/LodyAI/Lody/issues/3037)) ([bec92bb](https://github.com/LodyAI/Lody/commit/bec92bbb17efae6574553c73830e8311d7c9259e))
- **cli:** prevent Antigravity background tracker from sticking sessions in working state ([#3085](https://github.com/LodyAI/Lody/issues/3085)) ([ab452db](https://github.com/LodyAI/Lody/commit/ab452dbc5521dc3458de048bbac0f4f5e5af5b48))
- **cli:** reduce context usage metadata writes ([#2878](https://github.com/LodyAI/Lody/issues/2878)) ([52b37bf](https://github.com/LodyAI/Lody/commit/52b37bf5f92fbb4f9e23d1b4f008158ab948218f))
- **cli:** remove heuristic Antigravity sessionActivity synthesis ([#3097](https://github.com/LodyAI/Lody/issues/3097)) ([34eb2c1](https://github.com/LodyAI/Lody/commit/34eb2c16ccbd7d0374758d70de2f0a2d098f8bb7))
- **cli:** restore running state after stale ACP recovery ([#3201](https://github.com/LodyAI/Lody/issues/3201)) ([290d8f3](https://github.com/LodyAI/Lody/commit/290d8f336cb72247f3555b7b0a51d9d84cc51593))
- **cli:** upgrade simulator preview to upstream Baguette 0.2.15 [risk:medium] ([#2881](https://github.com/LodyAI/Lody/issues/2881)) ([6bda926](https://github.com/LodyAI/Lody/commit/6bda926e0a4ae185034b2eafd8a48b6294ef36a8))
- continue unsubmitted turns after GitHub owner changes ([#2886](https://github.com/LodyAI/Lody/issues/2886)) ([d4ebe8b](https://github.com/LodyAI/Lody/commit/d4ebe8b37d998c88b4b828bc536a1d231f166544))
- deduplicate machine flock capability and quota writes ([#2875](https://github.com/LodyAI/Lody/issues/2875)) ([2bea089](https://github.com/LodyAI/Lody/commit/2bea0895b8a83e4e5a9cbc0cfd9ca827f7cab36f))
- drop remaining bounds on Magpie model metadata ([eef73dc](https://github.com/LodyAI/Lody/commit/eef73dc10b8858ea9aa3d4d29359846e2d84b230))
- drop remaining bounds on Magpie model metadata ([adeaf37](https://github.com/LodyAI/Lody/commit/adeaf376b8d0ada8c7f96fb6a5c08e8f6d05f3d5))
- **e2ee:** text-only encrypted bug reports, transient Streams retries, late first key and ledger quota mapping [risk:high] ([#3168](https://github.com/LodyAI/Lody/issues/3168)) ([4174604](https://github.com/LodyAI/Lody/commit/4174604a102e7695e9c080646285b010e3362105))
- expose the lody command after standalone install [risk:medium] ([#3000](https://github.com/LodyAI/Lody/issues/3000)) ([5a8f28e](https://github.com/LodyAI/Lody/commit/5a8f28e5f92ce1d0005b14947ce4cc83e55a38c1))
- let the installer replace a running Lody after confirmation [risk:high] ([#2899](https://github.com/LodyAI/Lody/issues/2899)) ([588d8a7](https://github.com/LodyAI/Lody/commit/588d8a71f7ab2f981857f9612b9c737906b94093))
- load complete workspace changes when opening the list ([#2891](https://github.com/LodyAI/Lody/issues/2891)) ([32536a5](https://github.com/LodyAI/Lody/commit/32536a521f1d03187e4e5c52d79840cd3ba835df))
- make an explicit reinstall activate the installed daemon release [risk:medium] ([#3004](https://github.com/LodyAI/Lody/issues/3004)) ([28b6894](https://github.com/LodyAI/Lody/commit/28b68941f8f56e455c189ebebcbf25f5e29a5c89))
- **memory:** keep EverMe setup progressing on slow machines ([f3d8ee2](https://github.com/LodyAI/Lody/commit/f3d8ee24d35875e4460a12491abbb9748569ea00))
- persist Session metadata immediately so a crash cannot drop new Sessions ([#2915](https://github.com/LodyAI/Lody/issues/2915)) ([1c43179](https://github.com/LodyAI/Lody/commit/1c431793d791ea4ef96fed760abe9b01fec4de41))
- persist Streams recovery across process restarts ([#3109](https://github.com/LodyAI/Lody/issues/3109)) ([c6ed7f3](https://github.com/LodyAI/Lody/commit/c6ed7f31029e6739b5265e4a17556dcadba659d3))
- prevent session room sync lifecycle wedges and decouple local data-plane joins [risk:high] ([#2931](https://github.com/LodyAI/Lody/issues/2931)) ([2bbce0b](https://github.com/LodyAI/Lody/commit/2bbce0be4f5ddfc40a0c9238ab624de66b113f31))
- **preview:** keep previews alive across conversation switches and cache browser links ([#2973](https://github.com/LodyAI/Lody/issues/2973)) ([eb84b90](https://github.com/LodyAI/Lody/commit/eb84b90da91aadc79268bf4ae51f7cfacd5f2516))
- push committed Roost history from the owner ([#2923](https://github.com/LodyAI/Lody/issues/2923)) ([9c6ead1](https://github.com/LodyAI/Lody/commit/9c6ead128084bde60fdd0358aa15e69d246de28f))
- reconcile WS opt-in with main and native submodules ([77f06f5](https://github.com/LodyAI/Lody/commit/77f06f59ae97398f4bf5f5672b3a915f92894b2c))
- reject cloud Streams auth failures before gateway requests ([#3131](https://github.com/LodyAI/Lody/issues/3131)) ([c27e232](https://github.com/LodyAI/Lody/commit/c27e232564d2c651e392dae01f5b9520f29d7274))
- resolve project assets and redirects in previews ([#2879](https://github.com/LodyAI/Lody/issues/2879)) ([4b79e4a](https://github.com/LodyAI/Lody/commit/4b79e4a0470589088da875d574f19f234058b4d9))
- retain Roost catch-up pages across owner writes ([#2949](https://github.com/LodyAI/Lody/issues/2949)) ([e333ac8](https://github.com/LodyAI/Lody/commit/e333ac85a6ae69bbdead66804a2730c12a78a193))
- retain stopped queue drafts for explicit sending ([#2969](https://github.com/LodyAI/Lody/issues/2969)) ([4ddb8e4](https://github.com/LodyAI/Lody/commit/4ddb8e49df99259c7028c6d5eb5fc88c6c6e35bd))
- route ACP adapter, CLI fetch, WebSocket, Electron E2EE, and automation traffic through proxies ([#3172](https://github.com/LodyAI/Lody/issues/3172)) ([285a884](https://github.com/LodyAI/Lody/commit/285a8843f8eb0e253a3a8126f22dacb561d09ef1))
- **session:** bound stored history payloads and CRDT snapshot bloat ([#2943](https://github.com/LodyAI/Lody/issues/2943)) ([d7ba971](https://github.com/LodyAI/Lody/commit/d7ba9714c27d5c5ce26b0f171e46770d4d992171))
- show Antigravity slash commands and skills ([#2960](https://github.com/LodyAI/Lody/issues/2960)) ([f194b4d](https://github.com/LodyAI/Lody/commit/f194b4d6db008a72470154b0e8d2f053f3026081)), closes [#2956](https://github.com/LodyAI/Lody/issues/2956)
- skip repeated disabled Git commit identity lookups ([#3122](https://github.com/LodyAI/Lody/issues/3122)) ([c66cf0c](https://github.com/LodyAI/Lody/commit/c66cf0cda41f72ede1271cf9e472556ae7495d49))
- sync local project git summary and paginate remote branch queries ([#3117](https://github.com/LodyAI/Lody/issues/3117)) ([643c56e](https://github.com/LodyAI/Lody/commit/643c56e2d2dc813ada5e446e8b49db968c0bd2ba))
- **sync:** choose size-aware Flock snapshot catch-up ([#2876](https://github.com/LodyAI/Lody/issues/2876)) ([2d55ac5](https://github.com/LodyAI/Lody/commit/2d55ac571f168679ee6c8fa6f811e7e3942ce245))
- timestamp queued messages when promoted to session history ([#2937](https://github.com/LodyAI/Lody/issues/2937)) ([70aade4](https://github.com/LodyAI/Lody/commit/70aade4e51343e7d043c5e3519d4348bab3271a2))

### Performance

- search remote project files on the host and skip unchanged skill payloads ([#3114](https://github.com/LodyAI/Lody/issues/3114)) ([5e07e9e](https://github.com/LodyAI/Lody/commit/5e07e9e7dcab6544562695a98a97eb4be8e66f49))
- **shared,components:** defer loro/flock WASM init to workspace runtime ([#2993](https://github.com/LodyAI/Lody/issues/2993)) ([d52d285](https://github.com/LodyAI/Lody/commit/d52d2856ca13316abb9432003d3990fe4cf1b3d7))

### Refactors

- **memory:** drop cross-provider reveal and share job polling ([81bbaed](https://github.com/LodyAI/Lody/commit/81bbaedde9a49206253d3488eb4aa82b9c45e7b1))

## [0.76.0](https://github.com/loro-dev/lody/compare/lody-cli-v0.75.1...lody-cli-v0.76.0) (2026-08-03)


### Features

* **cli:** edit and resend last user message [risk:medium] ([#3277](https://github.com/loro-dev/lody/issues/3277)) ([42ad9df](https://github.com/loro-dev/lody/commit/42ad9df63ac679f4e9dd0dc1e269b10ee21f50b8))
* fully prewarm worktree ACP sessions [risk:medium] ([#3259](https://github.com/loro-dev/lody/issues/3259)) ([0706d98](https://github.com/loro-dev/lody/commit/0706d9821cc53de011b0aa463325352d576a881c))


### Bug Fixes

* **cli:** accept machine pairing tokens at every --auth entry point ([#3269](https://github.com/loro-dev/lody/issues/3269)) ([ad96ea0](https://github.com/loro-dev/lody/commit/ad96ea08b297ce4d7262e146724f60cfda82c707))
* **cli:** classify workspace sync failures as retryable [risk:medium] ([#3247](https://github.com/loro-dev/lody/issues/3247)) ([93d0b12](https://github.com/loro-dev/lody/commit/93d0b121473c4e18c23ef5f6b7f687cf59a8e900))
* **cli:** defer Codex auth to ACP [risk:high] ([#3237](https://github.com/loro-dev/lody/issues/3237)) ([c6e75c9](https://github.com/loro-dev/lody/commit/c6e75c9f496109ae422830e6e442142606b429a2))
* **cli:** publish session create MCP schemas [risk:medium] ([#3271](https://github.com/loro-dev/lody/issues/3271)) ([b08f743](https://github.com/loro-dev/lody/commit/b08f7435ff2904d0e83209c924ccbe1ac8ddaf14))
* **cli:** retry session materialization safely [risk:high] ([#3244](https://github.com/loro-dev/lody/issues/3244)) ([459a519](https://github.com/loro-dev/lody/commit/459a5193bd407d7978023f956d15d66744f49918))
* **cli:** stop worker OOM restart loops [risk:medium] ([#3241](https://github.com/loro-dev/lody/issues/3241)) ([1006ef9](https://github.com/loro-dev/lody/commit/1006ef96346575cdd0786ef86690c40ba3bef23c))
* **cli:** surface missing Git worktree error [risk:medium] ([#3239](https://github.com/loro-dev/lody/issues/3239)) ([6963293](https://github.com/loro-dev/lody/commit/69632937094f54e61e2df1a79a0ce269d0754b86))
* **local-project:** preserve exact branch boundaries [risk:high] ([#3263](https://github.com/loro-dev/lody/issues/3263)) ([b13db59](https://github.com/loro-dev/lody/commit/b13db596f79ab078deba28e869d6c35304b9def1))
* **local-project:** resolve registered repository branches [risk:high] ([#3246](https://github.com/loro-dev/lody/issues/3246)) ([4a41eeb](https://github.com/loro-dev/lody/commit/4a41eebff6dd93fc8defe3d14f7346cccb7760de))
* preserve ACP output across retries and reconnects [risk:high] ([#3257](https://github.com/loro-dev/lody/issues/3257)) ([cd001ea](https://github.com/loro-dev/lody/commit/cd001ea82d525af7fac3f240f83ba4253989dd72))
* **review:** configure reviewers per machine [risk:medium] ([#3260](https://github.com/loro-dev/lody/issues/3260)) ([edb3a1e](https://github.com/loro-dev/lody/commit/edb3a1e410e8d11f9918219776f0f9ca7284a70d))


### Refactors

* **sync:** replace LoroTransportMux with loro-repo native multi-transport [risk:high] ([#3274](https://github.com/loro-dev/lody/issues/3274)) ([e06c5aa](https://github.com/loro-dev/lody/commit/e06c5aad69f0c1315f117b8c2a950f29097a6398))

## [0.75.1](https://github.com/loro-dev/lody/compare/lody-cli-v0.75.0...lody-cli-v0.75.1) (2026-08-02)

### Bug Fixes

- **acp:** support legacy model switching [risk:medium]
  ([#3232](https://github.com/loro-dev/lody/issues/3232))
  ([74b892d](https://github.com/loro-dev/lody/commit/74b892d16258b78a1cc71030564a476ba7aca97f))

## [0.75.0](https://github.com/loro-dev/lody/compare/lody-cli-v0.74.0...lody-cli-v0.75.0) (2026-08-02)

### Features

- add auto review and merge review agent
  ([#3219](https://github.com/loro-dev/lody/issues/3219))
  ([5bce730](https://github.com/loro-dev/lody/commit/5bce7300a544573fe3c39b5522fe5ed548b14725))
- report daemon backend status
  ([#3209](https://github.com/loro-dev/lody/issues/3209))
  ([9f83b1b](https://github.com/loro-dev/lody/commit/9f83b1b2fce720982ff49b7cd5528020c10cdfbf))

### Bug Fixes

- derive session ids from room keys
  ([#3204](https://github.com/loro-dev/lody/issues/3204))
  ([321c889](https://github.com/loro-dev/lody/commit/321c8895baa81dae61798c35f8fdd04a575b57ea))
- hide Windows console windows when spawning child processes
  ([#3225](https://github.com/loro-dev/lody/issues/3225))
  ([d396be1](https://github.com/loro-dev/lody/commit/d396be1a4945116cb575a699a049490321e43efb))

## [0.74.0](https://github.com/loro-dev/lody/compare/lody-cli-v0.73.0...lody-cli-v0.74.0) (2026-07-31)

### ⚠ BREAKING CHANGES

- dual-author local-first — renderer and CLI direct-author their own data
  ([#3138](https://github.com/loro-dev/lody/issues/3138))

### Features

- add native ACP session fork
  ([#3133](https://github.com/loro-dev/lody/issues/3133))
  ([c4eaec5](https://github.com/loro-dev/lody/commit/c4eaec56a0cfcafd41d5e7537237c3ffae97c45b))
- add persistent side chats
  ([#3191](https://github.com/loro-dev/lody/issues/3191))
  ([ea3064e](https://github.com/loro-dev/lody/commit/ea3064ed902cab18fd54c2617ecc007cc875f4f6))
- add task image attachments
  ([#3181](https://github.com/loro-dev/lody/issues/3181))
  ([75d9c57](https://github.com/loro-dev/lody/commit/75d9c57bdc6a678798cf9a7ef6a267728cdafdda))
- dual-author local-first — renderer and CLI direct-author their own data
  ([#3138](https://github.com/loro-dev/lody/issues/3138))
  ([b54d3c9](https://github.com/loro-dev/lody/commit/b54d3c9cb393b048ae3338fb0fdf488c985d7e65))
- fork ACP sessions by native turn ID
  ([#3155](https://github.com/loro-dev/lody/issues/3155))
  ([373e15c](https://github.com/loro-dev/lody/commit/373e15c1a12542fff4431b0b558c577c5612fe80))
- replace session preview with browser
  ([ba84202](https://github.com/loro-dev/lody/commit/ba84202dc018e38986cab2dc2ddc6ca4efcb74c4))
- select model, reasoning effort, and fast/plan mode from MCP session create
  ([#3144](https://github.com/loro-dev/lody/issues/3144))
  ([7c33c85](https://github.com/loro-dev/lody/commit/7c33c85a645b4f0078d82a64f01573d097537370))
- **tasks:** add task list/create MCP tools and property writes
  ([#3175](https://github.com/loro-dev/lody/issues/3175))
  ([45e4c93](https://github.com/loro-dev/lody/commit/45e4c939c23ffe586498d606c35344128e8db308))
- **tasks:** Task as a first-class object (intent layer)
  ([#3123](https://github.com/loro-dev/lody/issues/3123))
  ([a99a96a](https://github.com/loro-dev/lody/commit/a99a96a686fe74a8551b16e5a511be4376c40c6a))

### Bug Fixes

- add end-to-end preview tunnel tracing
  ([#3121](https://github.com/loro-dev/lody/issues/3121))
  ([f72194b](https://github.com/loro-dev/lody/commit/f72194b363aa0de9893d3a9ffdbeec1df13c1675))
- bind staging preview route to staging worker
  ([f6751b8](https://github.com/loro-dev/lody/commit/f6751b88b37fb72ca9a859c323032f3556464604))
- bound session recovery bootstraps
  ([0bc8273](https://github.com/loro-dev/lody/commit/0bc827338959a2f7dcf6bd10194911da9518be60))
- **cli:** bound Delivery reconciliation work
  ([#3182](https://github.com/loro-dev/lody/issues/3182))
  ([e60c5d6](https://github.com/loro-dev/lody/commit/e60c5d6808f52836dcef1bb0cbef2caa636cf61e))
- **cli:** treat preview HTTP probe timeout as reachable
  ([#3192](https://github.com/loro-dev/lody/issues/3192))
  ([c8787f9](https://github.com/loro-dev/lody/commit/c8787f90c27e31005c8314c83fced23a34f26812))
- dedupe resurrected queued messages
  ([#3145](https://github.com/loro-dev/lody/issues/3145))
  ([3580eb8](https://github.com/loro-dev/lody/commit/3580eb8f7b651221a8659a4dd5a5d7923d522e80))
- drop build-essential requirement from npx lody
  ([#3135](https://github.com/loro-dev/lody/issues/3135))
  ([dde8b83](https://github.com/loro-dev/lody/commit/dde8b835115d76a526fce2a2fa98a6a0462794a5))
- fork
  ([b9d18cc](https://github.com/loro-dev/lody/commit/b9d18cc2e013f07400a3c3bb0e923d5d51e55a29))
- harden MCP orchestration under load
  ([#3185](https://github.com/loro-dev/lody/issues/3185))
  ([5d28509](https://github.com/loro-dev/lody/commit/5d28509c958bd1b6520f63007857ddc6619d143f))
- improve preview tunnel throughput
  ([78415a4](https://github.com/loro-dev/lody/commit/78415a414180a51b48076d2858a0ea6896a6172c))
- keep wasm-backed Flock scans as method calls
  ([#3177](https://github.com/loro-dev/lody/issues/3177))
  ([c9039ca](https://github.com/loro-dev/lody/commit/c9039cac0cefc44b20112f55320ce02afa3cee5f))
- open the reported preview directly from the Browser button
  ([#3147](https://github.com/loro-dev/lody/issues/3147))
  ([c943eda](https://github.com/loro-dev/lody/commit/c943edaf9d19491aa22ad9e375cbdec348c9951b))
- preserve preview connections across navigation
  ([#3126](https://github.com/loro-dev/lody/issues/3126))
  ([cb83d36](https://github.com/loro-dev/lody/commit/cb83d36bd646f7d84521f3d2bcf08dc09180d86c))
- preserve session owner for MCP-created sessions
  ([#3184](https://github.com/loro-dev/lody/issues/3184))
  ([a02951f](https://github.com/loro-dev/lody/commit/a02951fe486e5f1a26c96f312d4ed2650ed2bed0))
- probe both loopback literals for localhost preview targets
  ([#3124](https://github.com/loro-dev/lody/issues/3124))
  ([b27264f](https://github.com/loro-dev/lody/commit/b27264fad077a98be5d6becfbb3e349429413fa7))
- refresh PR poll sessions incrementally on metadata changes
  ([#3143](https://github.com/loro-dev/lody/issues/3143))
  ([97fbb64](https://github.com/loro-dev/lody/commit/97fbb647b679bde284e970a25dd2b31e2ce625c9))
- refresh stale npm metadata for registry agents
  ([#3130](https://github.com/loro-dev/lody/issues/3130))
  ([6a0199f](https://github.com/loro-dev/lody/commit/6a0199ff1adcae2be23c62662349c3ab8db46dcb))
- relay only local-origin presence over the local data plane
  ([#3153](https://github.com/loro-dev/lody/issues/3153))
  ([3ac1a97](https://github.com/loro-dev/lody/commit/3ac1a978d16f35270dd05ad6d92bf8883da8f0f3))
- scope Code Collab reconnect reconciliation
  ([#3170](https://github.com/loro-dev/lody/issues/3170))
  ([982ce41](https://github.com/loro-dev/lody/commit/982ce41f16c06ec0b11e1fd4637f755ffcea3c86))
- skip disabled fast mode for Claude Fable
  ([#3196](https://github.com/loro-dev/lody/issues/3196))
  ([e7876a4](https://github.com/loro-dev/lody/commit/e7876a42a3c0598db12da0d5b1f59582cb8ff4c1))
- stop dropping command output when spawn is slow
  ([#3139](https://github.com/loro-dev/lody/issues/3139))
  ([a7aa552](https://github.com/loro-dev/lody/commit/a7aa552d429bd44c39ec02865d8fe4373b826955))
- stop treating joining rooms as a broken Streams transport
  ([#3176](https://github.com/loro-dev/lody/issues/3176))
  ([6e156f3](https://github.com/loro-dev/lody/commit/6e156f3eecd503f3fe6bd7ade9dbc65f9d656fd5))
- **tasks:** confirm task proposal sync
  ([#3188](https://github.com/loro-dev/lody/issues/3188))
  ([91e4808](https://github.com/loro-dev/lody/commit/91e48088b91e4864826c4abb2bc88e73a3418352))
- **tasks:** reconcile repo existence with task index
  ([#3168](https://github.com/loro-dev/lody/issues/3168))
  ([63a8749](https://github.com/loro-dev/lody/commit/63a8749d1f59d1425f4bd1e5e0b5f734ff9367f2))
- validate preview tunnel readiness end to end
  ([1eefd2a](https://github.com/loro-dev/lody/commit/1eefd2a70df6d471823cb8c5eb294cf12b0b4902))

### Performance

- bound local history catalog pagination
  ([#3174](https://github.com/loro-dev/lody/issues/3174))
  ([f118b46](https://github.com/loro-dev/lody/commit/f118b46d6775ad765a30d81198739500e3beb46c))
- build the CLI with esbuild for pnpm dev instead of transpiling on demand
  ([#3178](https://github.com/loro-dev/lody/issues/3178))
  ([991f02b](https://github.com/loro-dev/lody/commit/991f02b3bd33aef81848db54edaa75ca952790fc))
- stop watching node_modules and .git in the Code Collab watcher
  ([#3180](https://github.com/loro-dev/lody/issues/3180))
  ([2e8b875](https://github.com/loro-dev/lody/commit/2e8b87580c977ddfb99967d48ad90798f2f637c5))

### Refactors

- derive session quotas from Flock
  ([#3117](https://github.com/loro-dev/lody/issues/3117))
  ([9d2f408](https://github.com/loro-dev/lody/commit/9d2f40851abbe0f5edb0c69da8c962404522fe8c))

## [0.73.0](https://github.com/loro-dev/lody/compare/lody-cli-v0.72.0...lody-cli-v0.73.0) (2026-07-26)

### Features

- add `lody app` to open the desktop app on a directory
  ([#3107](https://github.com/loro-dev/lody/issues/3107))
  ([cf75c49](https://github.com/loro-dev/lody/commit/cf75c49511dc946fcb0d7008c1f61c1374a993d7))

### Bug Fixes

- attribute session commits to the user who started the session
  ([#3109](https://github.com/loro-dev/lody/issues/3109))
  ([e7ba3db](https://github.com/loro-dev/lody/commit/e7ba3dbf90e83235186da5728f7cc3f426e76ccc))
- bound Code Collab reconnect republish work
  ([#3110](https://github.com/loro-dev/lody/issues/3110))
  ([aebb655](https://github.com/loro-dev/lody/commit/aebb6559312ff1fc9dd327f6b85e1c43f07eec7d))
- retry local project workdir resolution during session init
  ([#3108](https://github.com/loro-dev/lody/issues/3108))
  ([288cf32](https://github.com/loro-dev/lody/commit/288cf329b85c13d46ef45c65f9060aebe4e08c45))

## [0.72.0](https://github.com/loro-dev/lody/compare/lody-cli-v0.71.5...lody-cli-v0.72.0) (2026-07-25)

### Features

- expose session owner and presence-fused live status in MCP
  ([#3090](https://github.com/loro-dev/lody/issues/3090))
  ([06c43cb](https://github.com/loro-dev/lody/commit/06c43cb4e4f7571c9129358fe52d2a84c69ac920))

### Bug Fixes

- release trigger
  ([99478a6](https://github.com/loro-dev/lody/commit/99478a6ffe5d771845dbc7ca4920b88081e60546))
- unstick local-first sync — watchdog room sweep + doc delta chunking
  ([#3094](https://github.com/loro-dev/lody/issues/3094))
  ([bec7374](https://github.com/loro-dev/lody/commit/bec737436ea534f2e6659c71ed6c88b5730d3bea))

## [0.71.5](https://github.com/loro-dev/lody/compare/lody-cli-v0.71.4...lody-cli-v0.71.5) (2026-07-24)

### Bug Fixes

- release trigger
  ([0eda956](https://github.com/loro-dev/lody/commit/0eda9561f1ae295be0977fb78562ecb4f8d62780))
- release trigger
  ([5de3db8](https://github.com/loro-dev/lody/commit/5de3db87e9f20167a8c76b60af12bb94fa84c62b))

## [0.71.4](https://github.com/loro-dev/lody/compare/lody-cli-v0.71.3...lody-cli-v0.71.4) (2026-07-23)

### Bug Fixes

- skip unsupported proxy schemes instead of crashing all fetches
  ([#3080](https://github.com/loro-dev/lody/issues/3080))
  ([9bd2a9f](https://github.com/loro-dev/lody/commit/9bd2a9f88ab8bd59405e428f1dccc023ce132657))
- stop mis-folding turns into "Worked for …" summaries
  ([#3073](https://github.com/loro-dev/lody/issues/3073))
  ([0e4c015](https://github.com/loro-dev/lody/commit/0e4c0151961e7dd4a64f657ca9a4f83ead807d87))
- stop transient git failures from hiding Create PR / Commit & Push
  ([#3077](https://github.com/loro-dev/lody/issues/3077))
  ([222dd7d](https://github.com/loro-dev/lody/commit/222dd7d6b2f1ac1c2fcc29443fcd13919a842208))

## [0.71.3](https://github.com/loro-dev/lody/compare/lody-cli-v0.71.2...lody-cli-v0.71.3) (2026-07-23)

### Bug Fixes

- don't delete dispatched sessions on best-effort Streams ack
  ([39b33f2](https://github.com/loro-dev/lody/commit/39b33f274078a05ae939e9ffb0747c37c3fa57f0))
- don't delete dispatched sessions on best-effort Streams ack
  ([b7a53cd](https://github.com/loro-dev/lody/commit/b7a53cde3f15e5857d033772d0eec191cc29e9c6))
- eliminate operation-store "database is locked" contention
  ([#3058](https://github.com/loro-dev/lody/issues/3058))
  ([3e4dc48](https://github.com/loro-dev/lody/commit/3e4dc481a507cbd5e18087eedfd4a292e5ed9402))
- invoke pnpm via corepack in prepare:acp-adapters
  ([ead6af4](https://github.com/loro-dev/lody/commit/ead6af4164d7cbae5eef9ae5be027be3d2ae1c47))
- open workspace-contained absolute file paths
  ([#3063](https://github.com/loro-dev/lody/issues/3063))
  ([cb1e536](https://github.com/loro-dev/lody/commit/cb1e536af2be703d87ecefaf5dd73aaac448e850))
- restore isolated Codex title generation
  ([#3066](https://github.com/loro-dev/lody/issues/3066))
  ([c17a6b8](https://github.com/loro-dev/lody/commit/c17a6b8a7efb274cd5c1a58a7caf5bb63dfe64e0))

## [0.71.2](https://github.com/loro-dev/lody/compare/lody-cli-v0.71.1...lody-cli-v0.71.2) (2026-07-22)

### Bug Fixes

- hold one operation-store connection to stop WAL self-wake loop
  ([#3055](https://github.com/loro-dev/lody/issues/3055))
  ([ec46492](https://github.com/loro-dev/lody/commit/ec464922ffbee2a5426de90e531eec16cdffe69e))
- skip auto-commit for non-worktree local projects
  ([#3052](https://github.com/loro-dev/lody/issues/3052))
  ([10bed12](https://github.com/loro-dev/lody/commit/10bed12255f79b6aa161e3e2609c4bdf5a65cc50))

## [0.71.1](https://github.com/loro-dev/lody/compare/lody-cli-v0.71.0...lody-cli-v0.71.1) (2026-07-22)

### Bug Fixes

- run internal session commands without bash
  ([#3049](https://github.com/loro-dev/lody/issues/3049))
  ([567dcfc](https://github.com/loro-dev/lody/commit/567dcfc8385582ad90ab8de453919449c4546f5f))

## [0.71.0](https://github.com/loro-dev/lody/compare/lody-cli-v0.70.2...lody-cli-v0.71.0) (2026-07-22)

### Features

- add built-in Kimi Code managed runtime
  ([#2946](https://github.com/loro-dev/lody/issues/2946))
  ([e15f831](https://github.com/loro-dev/lody/commit/e15f83197641d8eb247745810a46359343795631))
- add daemon PR status poller with presence-driven scheduling
  ([#2945](https://github.com/loro-dev/lody/issues/2945))
  ([cceda63](https://github.com/loro-dev/lody/commit/cceda63a9869319f3d92eb2a9db2f186bd49c2bc))
- add local dispatch access policy
  ([422314d](https://github.com/loro-dev/lody/commit/422314ddf9c9815b2a7567fe3df857c61563b242))
- add local Loro data plane
  ([4b49d56](https://github.com/loro-dev/lody/commit/4b49d56cba0cee5e79e7f918ee2f0be3e9415a4c))
- add local preview endpoints
  ([a119908](https://github.com/loro-dev/lody/commit/a11990869700a8f7f10dbf3a800e454cfa1c23bf))
- add local-first catalog bootstrap
  ([e451001](https://github.com/loro-dev/lody/commit/e4510015e9a310ab3616193cd11086ffc014fbba))
- add on-demand device resource monitoring
  ([#2849](https://github.com/loro-dev/lody/issues/2849))
  ([393c046](https://github.com/loro-dev/lody/commit/393c04621a1520e1a6380e2e3d56bf9b55c5000c))
- add queue and guide message behavior
  ([#2854](https://github.com/loro-dev/lody/issues/2854))
  ([e75b605](https://github.com/loro-dev/lody/commit/e75b605527fcd2ad5f81c3d054e1ad2a31fdd264))
- add remote bridge orchestration
  ([07ac75d](https://github.com/loro-dev/lody/commit/07ac75da4fdcf7bdac4ebcbaca10372574e2cf14))
- add secure machine pairing flow
  ([#2929](https://github.com/loro-dev/lody/issues/2929))
  ([445924b](https://github.com/loro-dev/lody/commit/445924b46f4555e0e585aa8696a4891c8bacb687))
- add UI-only provider authentication
  ([#2952](https://github.com/loro-dev/lody/issues/2952))
  ([b88816b](https://github.com/loro-dev/lody/commit/b88816b01e4bbd835c071fd64cb1e66ced057826))
- carry presence over the local data plane (local-first online status)
  ([fbec30a](https://github.com/loro-dev/lody/commit/fbec30a20883c4e58ac4197ec7325dbde4363458))
- CLI authors workspace write-intents as sole author (local-first)
  ([8a2efc6](https://github.com/loro-dev/lody/commit/8a2efc6c96b5653f71da405e06f94ea8f1cbc182))
- **cli:** rebuild PR status poller as a spec-driven pure-module reconciler
  ([#3016](https://github.com/loro-dev/lody/issues/3016))
  ([e625a46](https://github.com/loro-dev/lody/commit/e625a468808c9721e815aaa93192475e175dc76f))
- codex 5 6 ([#2839](https://github.com/loro-dev/lody/issues/2839))
  ([84ffe5f](https://github.com/loro-dev/lody/commit/84ffe5fb3a046b8b889b7428cf9049d50cdcce04))
- expose ACP prewarm diagnostics in DevTools
  ([b2e8c8f](https://github.com/loro-dev/lody/commit/b2e8c8f157e7143055bbea124f68e5702ad041fb))
- expose ACP prewarm readiness in DevTools
  ([03f72c5](https://github.com/loro-dev/lody/commit/03f72c523f8f34d16ecd65fac2000782658a9792))
- implement local-first attachments preview
  ([184e48e](https://github.com/loro-dev/lody/commit/184e48e5101d108b77bc95e933d5f253456c386b))
- integrate acknowledged Codex steer
  ([#2862](https://github.com/loro-dev/lody/issues/2862))
  ([8851d37](https://github.com/loro-dev/lody/commit/8851d37ae1f65558459c6a46556aff2d8446d4fe))
- integrate Codex ACP session updates
  ([#2895](https://github.com/loro-dev/lody/issues/2895))
  ([5d0bf1d](https://github.com/loro-dev/lody/commit/5d0bf1d53a08cef5ec3bd8a8b4848e1b63936a35))
- keep sessions alive after turn_end + pending scheduled tasks UI
  ([#2762](https://github.com/loro-dev/lody/issues/2762))
  ([40ed3ea](https://github.com/loro-dev/lody/commit/40ed3ea6bbc0b20130a718341738ff7f4863c93c))
- keep sessions alive after turn_end + pending scheduled-tasks panel
  ([#2771](https://github.com/loro-dev/lody/issues/2771))
  ([b5ea62b](https://github.com/loro-dev/lody/commit/b5ea62bf04aebd8df1a4934663738b398b895a7b))
- optimize cli prompt hot path
  ([#2772](https://github.com/loro-dev/lody/issues/2772))
  ([5fc7190](https://github.com/loro-dev/lody/commit/5fc7190abd152e06c9dd6ced705755615a48ff50))
- presence-based machine online status + session status strip
  ([#2857](https://github.com/loro-dev/lody/issues/2857))
  ([dcd176f](https://github.com/loro-dev/lody/commit/dcd176febabc12e640d47699fa5c99792d8731aa))
- prewarm ACP sessions from chat drafts
  ([1ca3510](https://github.com/loro-dev/lody/commit/1ca351078b7499d9455e194d262289ad4ed930f4))
- push-based local Loro data plane with version-vector deltas (B, R3/R4)
  ([66fa49b](https://github.com/loro-dev/lody/commit/66fa49b33fa5d2403a3e5403a68c23441feb6f65))
- redesign Lody MCP session orchestration
  ([#2994](https://github.com/loro-dev/lody/issues/2994))
  ([099b1a6](https://github.com/loro-dev/lody/commit/099b1a6a997ee606a333759a9fb1432e44438525))
- refine agent session rendering and usage
  ([6741215](https://github.com/loro-dev/lody/commit/674121524129900473cee975e28cd085492d93d8))
- refresh ACP capabilities automatically
  ([#2897](https://github.com/loro-dev/lody/issues/2897))
  ([36f78ff](https://github.com/loro-dev/lody/commit/36f78ff0df477d13266c9f4ab3c1329e8db2d3bc))
- remove local port transports
  ([bf4cf7c](https://github.com/loro-dev/lody/commit/bf4cf7c7893d866b6a721d5ff9b1a94536db5c4c))
- resolve CLI workspaces by name
  ([#3035](https://github.com/loro-dev/lody/issues/3035))
  ([89d8ce7](https://github.com/loro-dev/lody/commit/89d8ce700550b4fd918ce497b2818ba13b138c4e))
- rewrite local Loro data plane as peer-scoped protocol v3
  ([0e18d1e](https://github.com/loro-dev/lody/commit/0e18d1ebe3b0c2b1daf7bb17f7628b82ea0c6117))
- show Claude Code `fast` config option like Codex fast-mode
  ([#2727](https://github.com/loro-dev/lody/issues/2727))
  ([a8438bf](https://github.com/loro-dev/lody/commit/a8438bf35477b44e0ad1ff79852e837384f25bd8))
- show Claude Code `fast` config option like Codex fast-mode
  ([#2727](https://github.com/loro-dev/lody/issues/2727))
  ([a17db18](https://github.com/loro-dev/lody/commit/a17db18fac98b763df2dffc34bc90b690f633924))
- surface mergeable pull request actions
  ([#3002](https://github.com/loro-dev/lody/issues/3002))
  ([6a6db24](https://github.com/loro-dev/lody/commit/6a6db24f3f63056f8af3b9fe1b5fc40e63ab940b))
- sync CLI session reads ([#2816](https://github.com/loro-dev/lody/issues/2816))
  ([d4f01a3](https://github.com/loro-dev/lody/commit/d4f01a3ca724351106d1a2e7999ef09bdbae2b54))
- trace CLI session startup latency
  ([6fddd53](https://github.com/loro-dev/lody/commit/6fddd530ee605925f307f089ac2e7068b93d8f7c))
- use ACP-native session titles
  ([#3011](https://github.com/loro-dev/lody/issues/3011))
  ([62ae544](https://github.com/loro-dev/lody/commit/62ae54481b947ac21635aee6b06e0cf10baf03c1))
- wire session/dispatch-turn over local Machine RPC in local-first mode
  ([c04d3d7](https://github.com/loro-dev/lody/commit/c04d3d781e511d27f0a0907dc7fbd0ef756c93c4))

### Bug Fixes

- 5.6 price
  ([1ab917e](https://github.com/loro-dev/lody/commit/1ab917e4281602787340dd195e466942e2cbb181))
- add Kimi Code install dir to ACP PATH
  ([#2928](https://github.com/loro-dev/lody/issues/2928))
  ([dbf43b1](https://github.com/loro-dev/lody/commit/dbf43b1a1833d3e7a78dae82bc3edd03beca3a10))
- add session dispatch startup diagnostics
  ([#2728](https://github.com/loro-dev/lody/issues/2728))
  ([fe19768](https://github.com/loro-dev/lody/commit/fe19768a4da77c2ba804777ddbd13d99d74668cf))
- address project sharing review
  ([819f2b4](https://github.com/loro-dev/lody/commit/819f2b42c4297c6c8d970eb34ae811801f8e2e57))
- agent config storage and install setup
  ([#2737](https://github.com/loro-dev/lody/issues/2737))
  ([9cdc08e](https://github.com/loro-dev/lody/commit/9cdc08e3bc99b2c7a0c64392c0febfdb6abc0aac))
- aggregate mux member status and sync results instead of masking failures
  ([9b629fc](https://github.com/loro-dev/lody/commit/9b629fc97164e0846fb0cdae8a8ee8f65b1d63f3))
- allow local preview module chains
  ([ce9156c](https://github.com/loro-dev/lody/commit/ce9156c1d03ff63c8e884ea159967da110eb32fa))
- allow local preview subresources
  ([26a3d0b](https://github.com/loro-dev/lody/commit/26a3d0bf91e4844784ac0a55dc452733a4f70732))
- await login-shell PATH before ACP spawn
  ([#2925](https://github.com/loro-dev/lody/issues/2925))
  ([1ea91b0](https://github.com/loro-dev/lody/commit/1ea91b00430428d7315edc6ea20c6d333a12f332))
- bound cloud side-effect waits in turn finalization
  ([cc24165](https://github.com/loro-dev/lody/commit/cc24165053836a58ec0333a19b6214af35bb1863))
- bound terminal output history
  ([#2889](https://github.com/loro-dev/lody/issues/2889))
  ([fdbb353](https://github.com/loro-dev/lody/commit/fdbb353c0800a573f409b64c02e26465caac5b00))
- bridge local code collab flock rooms
  ([a3290c6](https://github.com/loro-dev/lody/commit/a3290c6ba54f3e2ac38e64a020302a98768135ab))
- build vendored acp adapters before cli bundle
  ([#2795](https://github.com/loro-dev/lody/issues/2795))
  ([cbf974c](https://github.com/loro-dev/lody/commit/cbf974ca622f56ff282f71e04d231663d83e343f))
- builtin ACP capability refresh
  ([#2798](https://github.com/loro-dev/lody/issues/2798))
  ([c3b408c](https://github.com/loro-dev/lody/commit/c3b408c1085a37d223d21ffa67690f754efc79a9))
- clear session presence after turns
  ([#2767](https://github.com/loro-dev/lody/issues/2767))
  ([83cb038](https://github.com/loro-dev/lody/commit/83cb0387cfa046cd30e9cfe9bd1d85ddb45b14f5))
- **cli:** centralize session active presence
  ([#2768](https://github.com/loro-dev/lody/issues/2768))
  ([be90426](https://github.com/loro-dev/lody/commit/be90426cbae87e73f0a3f01ed6530943a4ea4014))
- **cli:** forward deployment env to lody mcp
  ([89fa63b](https://github.com/loro-dev/lody/commit/89fa63b54c30f86b77becc04344cbc190846de11))
- **cli:** repair dev sqlite ABI mismatch
  ([b553433](https://github.com/loro-dev/lody/commit/b553433e15a5f369a12318eeacda9b710dc9c214))
- **cli:** start the PR reconciler before the local-first workspace bootstrap
  ([#3022](https://github.com/loro-dev/lody/issues/3022))
  ([74c77f7](https://github.com/loro-dev/lody/commit/74c77f719812c95d1449f7f6321a3141ef943c34))
- **cli:** update stale dev script assertion in dev-adapter-build test
  ([#3017](https://github.com/loro-dev/lody/issues/3017))
  ([f9c5ab6](https://github.com/loro-dev/lody/commit/f9c5ab66b87e306cf55bbc61eee0276ab9989d9e))
- crash-safe session-file backfill + draft blob reclamation (R5.3/5.4)
  ([6ef5f21](https://github.com/loro-dev/lody/commit/6ef5f21ba4ee52813dee7a039a6cf8a6a671a852))
- default builtin agents to auto mode
  ([#2964](https://github.com/loro-dev/lody/issues/2964))
  ([12ba2e2](https://github.com/loro-dev/lody/commit/12ba2e251a550f6a462e3e181748241fe3105518))
- default CLI DNS result order to ipv4first
  ([#3006](https://github.com/loro-dev/lody/issues/3006))
  ([7130db4](https://github.com/loro-dev/lody/commit/7130db4b00ab6b0d6ce978247ad6af7bee8b9133))
- default CLI DNS result order to ipv4first
  ([#3006](https://github.com/loro-dev/lody/issues/3006))
  ([3f01b7c](https://github.com/loro-dev/lody/commit/3f01b7c0a47996c3b05b6730e3bfb59181804afe))
- derive mirrored runtimes from dependencies
  ([3bb37d9](https://github.com/loro-dev/lody/commit/3bb37d9dcbb10a203375b9ce481892ce56c3c2ba))
- dispatch steer after target turn ends
  ([#2938](https://github.com/loro-dev/lody/issues/2938))
  ([ade7ee4](https://github.com/loro-dev/lody/commit/ade7ee40f599adad20d681cb337f53a81be8c2a3))
- expose code collab sync failures
  ([dce4e23](https://github.com/loro-dev/lody/commit/dce4e235b479991baabe7af1bddd11747ccb6f7d))
- Fix CLI auth fetch over HTTP transport
  ([#2742](https://github.com/loro-dev/lody/issues/2742))
  ([d627d52](https://github.com/loro-dev/lody/commit/d627d522713a8ae81b6a98ac04c48010c89f80f8))
- follow release version for iOS App Store release
  ([#2726](https://github.com/loro-dev/lody/issues/2726))
  ([a8438bf](https://github.com/loro-dev/lody/commit/a8438bf35477b44e0ad1ff79852e837384f25bd8))
- follow release version for iOS App Store release
  ([#2726](https://github.com/loro-dev/lody/issues/2726))
  ([a17db18](https://github.com/loro-dev/lody/commit/a17db18fac98b763df2dffc34bc90b690f633924))
- gate builtin provider registration on machine sync
  ([#2812](https://github.com/loro-dev/lody/issues/2812))
  ([cad5dff](https://github.com/loro-dev/lody/commit/cad5dff8ce9827554a8f73019f9ce9415d165991))
- gate RPC fast-path turn output behind user-turn history sync
  ([#2766](https://github.com/loro-dev/lody/issues/2766))
  ([26b1131](https://github.com/loro-dev/lody/commit/26b1131b96ce216979d6acfca949b45cbb3ece06))
- gate turn cloud side effects on cloud-plane connectivity
  ([7e8df2a](https://github.com/loro-dev/lody/commit/7e8df2a0e597b021e44ee80eb49cbbd9321bc03e))
- guard remote bridge attach with an epoch against detach races (R2)
  ([e3962a3](https://github.com/loro-dev/lody/commit/e3962a3f715ba228c1b0401974be21d6c1b52b68))
- harden local agent host ownership
  ([#2873](https://github.com/loro-dev/lody/issues/2873))
  ([549c807](https://github.com/loro-dev/lody/commit/549c807a7e8147ad78c37845a9800695d0a1c58d))
- harden local IPC layer (terminal socket run dir, response cap, server
  lifecycle)
  ([963e004](https://github.com/loro-dev/lody/commit/963e0045b03a7830c0dd4d9f0d1c85a1c09c92d2))
- harden local IPC socket client and trim dead client surface
  ([e0d5d53](https://github.com/loro-dev/lody/commit/e0d5d53f66ea701df51f76a09a9e5a53f91be4cf))
- harden local loro data-plane sync
  ([830072e](https://github.com/loro-dev/lody/commit/830072ecbab411e29597e06a1df9b634d17fe122))
- harden local-first P5-P7 review findings
  ([781fbc2](https://github.com/loro-dev/lody/commit/781fbc2f90eff1e40cd37a96220955b024b851d4))
- harden local-first review low-risk findings
  ([ea60b4a](https://github.com/loro-dev/lody/commit/ea60b4a954b72a0a2ec96866d114dca0fc0020e3))
- harden mux attach, fleet reconcile retry, blob quota race (R5.2/5.5/5.6)
  ([f97eadb](https://github.com/loro-dev/lody/commit/f97eadbfee043005e1f2f290a04e0487f6f62a1d))
- hydrate local session docs on renderer join
  ([6ea0e12](https://github.com/loro-dev/lody/commit/6ea0e1240c21deaf40c72a3ec74c482c7f662b06))
- ignore Codex commentary in session titles
  ([#2866](https://github.com/loro-dev/lody/issues/2866))
  ([bc8cff2](https://github.com/loro-dev/lody/commit/bc8cff2a4a7c4215110c7c431275e6fc58208ac0))
- improve CLI startup diagnostics
  ([#2747](https://github.com/loro-dev/lody/issues/2747))
  ([1a6d9cb](https://github.com/loro-dev/lody/commit/1a6d9cb0ebeb8bc808bfd8483f0b5d399f15ab40))
- improve device resource monitoring
  ([#2864](https://github.com/loro-dev/lody/issues/2864))
  ([9b9f969](https://github.com/loro-dev/lody/commit/9b9f969d571041fe0f545c3960910531e06a4fa4))
- improve managed runtime onboarding
  ([#2788](https://github.com/loro-dev/lody/issues/2788))
  ([b1bf057](https://github.com/loro-dev/lody/commit/b1bf057f100d6733917d0d0f23b8d149114b6959))
- isolate Code Collab filesystem watchers
  ([#2990](https://github.com/loro-dev/lody/issues/2990))
  ([7dfde5a](https://github.com/loro-dev/lody/commit/7dfde5ae2f621c9540dd223897cc4d9e5fa178fc))
- Isolate session bootstrap from workspace startup
  ([#2731](https://github.com/loro-dev/lody/issues/2731))
  ([d345432](https://github.com/loro-dev/lody/commit/d3454324f23d31570c496d885480b08787c67150))
- keep agent registration off CLI startup path
  ([65d4a24](https://github.com/loro-dev/lody/commit/65d4a245d8c0ba30833cdba63e829ac97f860aa0))
- keep Electron watch worker in Node mode
  ([#3038](https://github.com/loro-dev/lody/issues/3038))
  ([3cbb6c2](https://github.com/loro-dev/lody/commit/3cbb6c2dbdc58df26a144e41da87e5572d530222))
- load remote code collab files over machine rpc
  ([590b1f7](https://github.com/loro-dev/lody/commit/590b1f75f41253f1574d8ccb70f3dcffd8a4b93b))
- log managed runtime resolution timing
  ([#2989](https://github.com/loro-dev/lody/issues/2989))
  ([9f4b382](https://github.com/loro-dev/lody/commit/9f4b382ae80b49626edd715b6751399ad8ad0738))
- make Electron auth callback transactional
  ([#2907](https://github.com/loro-dev/lody/issues/2907))
  ([e53a795](https://github.com/loro-dev/lody/commit/e53a795eb6f06d26e503a53f04324e611e42eb55))
- make local access cache optimistic-allow only (R1)
  ([f37f073](https://github.com/loro-dev/lody/commit/f37f07332b1ca10988dc6f366fdb1f4f21fb94f6))
- make remote auth follow local readiness
  ([d30a369](https://github.com/loro-dev/lody/commit/d30a369c61f449e2268e00b9b32f2896174bb1b3))
- make session working presence heartbeat foolproof
  ([#2759](https://github.com/loro-dev/lody/issues/2759))
  ([93fb0fe](https://github.com/loro-dev/lody/commit/93fb0fe85289061bc13a5aaeb72363ff346b0677))
- make write-intent delivery exactly-once and send failures visible
  ([2ac31ec](https://github.com/loro-dev/lody/commit/2ac31ec60907e0c1d9357461baf0db1475a534bf))
- manage builtin agent runtimes
  ([#2724](https://github.com/loro-dev/lody/issues/2724))
  ([d1d6713](https://github.com/loro-dev/lody/commit/d1d671320d9459c60267ac659dc3c78b2fe58a95))
- move CLI resource probes off prompt path
  ([90e8b47](https://github.com/loro-dev/lody/commit/90e8b47c49ceac515622a9f1e0a320b82d081fef))
- move local IPC sockets out of tmpdir and guard stale cleanup (S1)
  ([1bf99cd](https://github.com/loro-dev/lody/commit/1bf99cd945569018cc872ea15b8ad4a05807e070))
- normalize ACP prewarm compatibility
  ([3ceb0c2](https://github.com/loro-dev/lody/commit/3ceb0c2e26e480224d6ea9f6534ca2cfe3bebd31))
- overlap CLI startup network checks
  ([f4419b1](https://github.com/loro-dev/lody/commit/f4419b11c52730b1ddce6412cc504d5c74c662d5))
- pass system proxy to managed runtime downloads
  ([#2797](https://github.com/loro-dev/lody/issues/2797))
  ([999e96b](https://github.com/loro-dev/lody/commit/999e96b45496aa1c8c532219d8c64aa8a28f2060))
- preempt doc sync for RPC dispatch
  ([532c541](https://github.com/loro-dev/lody/commit/532c541d651846437e4ea806d04795bfedbcf08f))
- prepare acp adapters before cli typecheck
  ([#2852](https://github.com/loro-dev/lody/issues/2852))
  ([f8c6ebe](https://github.com/loro-dev/lody/commit/f8c6ebea7a1bee251a49cf86d82e09873f8a0c66))
- preserve authoritative ACP session defaults
  ([#2894](https://github.com/loro-dev/lody/issues/2894))
  ([7520ce1](https://github.com/loro-dev/lody/commit/7520ce1b9775f27d797c1b268976bef2ddbea896))
- preserve local preview request context
  ([ef0401f](https://github.com/loro-dev/lody/commit/ef0401fb8458533203b142a23c1aeb7ba2c3e23d))
- preserve visibility coverage after auth recovery merge
  ([69fbe82](https://github.com/loro-dev/lody/commit/69fbe8230660031e0779650074a62cf0feaeb7ee))
- prioritize local session start acknowledgements
  ([9489150](https://github.com/loro-dev/lody/commit/948915049d03ec1cd25d805d3e51673b79656519))
- rebuild ACP adapters before CLI dev
  ([#2891](https://github.com/loro-dev/lody/issues/2891))
  ([a6b06c4](https://github.com/loro-dev/lody/commit/a6b06c490b7a861d2c9c898916c3e598ef2866bc))
- recover Electron-managed CLI credentials
  ([530c370](https://github.com/loro-dev/lody/commit/530c370c874314d4e8f03cda6aa44676cab8087d))
- recover PR auth automatically
  ([#2933](https://github.com/loro-dev/lody/issues/2933))
  ([36df693](https://github.com/loro-dev/lody/commit/36df693b3a5455cd8b218cf478cfe2d24256b785))
- recover stale ACP session-not-found prompts
  ([#2819](https://github.com/loro-dev/lody/issues/2819))
  ([0fc48ed](https://github.com/loro-dev/lody/commit/0fc48edd07b37f0e6c33eebba75bb8038a66eff2))
- reduce local chat send latency
  ([4b1f1f0](https://github.com/loro-dev/lody/commit/4b1f1f0d47be1affa495adb6fbae44649e442fdf))
- reduce session dispatch latency (ChatLanding → CLI fast path)
  ([#2754](https://github.com/loro-dev/lody/issues/2754))
  ([6bc018f](https://github.com/loro-dev/lody/commit/6bc018f015809d107ae5f46be72c63b18a694709))
- refresh local code collab file index
  ([8d90b86](https://github.com/loro-dev/lody/commit/8d90b86085453925f8353aff244b3d5c10cc3c22))
- relax Loro Streams RPC connect timeout
  ([#2734](https://github.com/loro-dev/lody/issues/2734))
  ([5194fff](https://github.com/loro-dev/lody/commit/5194fffe9b81d271fff0116feacf40bc5987bab6))
- relay local session sync status
  ([93f9dd3](https://github.com/loro-dev/lody/commit/93f9dd38bc62b576c6587151cb7167cb1bcbad31))
- release trigger
  ([bbabba0](https://github.com/loro-dev/lody/commit/bbabba06ad7018a00b6496d73dfa9323d4ed5915))
- release trigger
  ([5f98e92](https://github.com/loro-dev/lody/commit/5f98e92f0a30aa978bbff2281ed545a38be37220))
- remove CLI prompt startup overhead
  ([c10d9ad](https://github.com/loro-dev/lody/commit/c10d9adb58a25e186adee2212dd8fc4e81b43df5))
- remove full access mode
  ([#2752](https://github.com/loro-dev/lody/issues/2752))
  ([0e1f856](https://github.com/loro-dev/lody/commit/0e1f856bcfd34fac46c42e605daae21da5016ada))
- republish CLI presence after reconnect
  ([#2869](https://github.com/loro-dev/lody/issues/2869))
  ([3406ae9](https://github.com/loro-dev/lody/commit/3406ae970e6bbb90a87142394ce84d2583603857))
- require GitHub App user tokens for personal operations
  ([#2974](https://github.com/loro-dev/lody/issues/2974))
  ([6fceb14](https://github.com/loro-dev/lody/commit/6fceb14b920c350568cb5491ac583fc644ead0d4))
- restore Codex goal banners
  ([#2841](https://github.com/loro-dev/lody/issues/2841))
  ([bd31a54](https://github.com/loro-dev/lody/commit/bd31a54eb536f060add5d1a45d0baddaa22bf83c))
- restore pre-release verification gates
  ([294086a](https://github.com/loro-dev/lody/commit/294086ad9ba46678abb92ff4b64826907ab721c1))
- retry machine flock sync in background
  ([#2815](https://github.com/loro-dev/lody/issues/2815))
  ([7c3068c](https://github.com/loro-dev/lody/commit/7c3068cb573e32ba0958898fc164afd8f189d995))
- route local data-plane meta room to the repo's internal metaFlock
  ([109ca69](https://github.com/loro-dev/lody/commit/109ca69042f60446a5e1dae539719dbe1b9fe29e))
- route local machine monitoring over local data plane
  ([65f94f9](https://github.com/loro-dev/lody/commit/65f94f95c59a93d950bd5b5e8bdf9d1f7ce1f671))
- route local-first workspaces per target
  ([f697449](https://github.com/loro-dev/lody/commit/f69744983c3102bd630ee1e6cbf8fa59acd60831))
- separate ACP static capabilities from runtime refresh
  ([#2814](https://github.com/loro-dev/lody/issues/2814))
  ([6193eee](https://github.com/loro-dev/lody/commit/6193eee8b310cd65fd3f41e90af72622d17757fc))
- serve pinned registry ACP agents from the npx cache offline
  ([f41b709](https://github.com/loro-dev/lody/commit/f41b709d0de0ae6837ad918fb9b79c3ec753d4f2))
- shorten Codex full access label
  ([#2834](https://github.com/loro-dev/lody/issues/2834))
  ([40fced1](https://github.com/loro-dev/lody/commit/40fced1e41378af7460f448c93dafc84a409f597))
- show newly-created agent providers from machine flock
  ([#2740](https://github.com/loro-dev/lody/issues/2740))
  ([d8cbed3](https://github.com/loro-dev/lody/commit/d8cbed3bb9fab60e76311f989e09bc6140627e83))
- show sharing status only for private access
  ([#2969](https://github.com/loro-dev/lody/issues/2969))
  ([40da7e3](https://github.com/loro-dev/lody/commit/40da7e329cc80651b0d3765bc3099d025a7a0ecf))
- single-writer bridge transitions, real owner recheck, revoke aborts in-flight
  backfill
  ([c4075b5](https://github.com/loro-dev/lody/commit/c4075b5f975f52bfdc35188b3d695df975a1b394))
- skip worktree setup on session restore
  ([#2751](https://github.com/loro-dev/lody/issues/2751))
  ([f2f0be9](https://github.com/loro-dev/lody/commit/f2f0be929a907e3b46e5f60471f864aa85dd71c7))
- source ACP slash commands from session response
  ([#3031](https://github.com/loro-dev/lody/issues/3031))
  ([7d086f0](https://github.com/loro-dev/lody/commit/7d086f04340e71b68d6667b6eefe3471e0027299))
- speed up local-first CLI startup
  ([f4e9fc3](https://github.com/loro-dev/lody/commit/f4e9fc33295a1d65b9789858e2fe2d1b3bb70ea1))
- stop cloud room status from poisoning local-first room health
  ([1f2ae45](https://github.com/loro-dev/lody/commit/1f2ae45181c9470a65ba9bb59537a5fcfcd4dfd8))
- stop Codex noise from leaking into session titles
  ([#2935](https://github.com/loro-dev/lody/issues/2935))
  ([11bef3d](https://github.com/loro-dev/lody/commit/11bef3da389b01ed17ab72021b2eafb6a0a6896b))
- sync local projects through machine flock
  ([#2976](https://github.com/loro-dev/lody/issues/2976))
  ([509528b](https://github.com/loro-dev/lody/commit/509528b29eb2942a5e86aa0a5cdbfd81b2fbcb22))
- sync worktree diff stats to session meta
  ([#2923](https://github.com/loro-dev/lody/issues/2923))
  ([195b685](https://github.com/loro-dev/lody/commit/195b6850563effcb043f5c32b1321ef670010563))
- treat local dispatch pending as working
  ([6cc075d](https://github.com/loro-dev/lody/commit/6cc075d11fb7fe37437d28296127b5a00b730582))

### Performance

- reduce flock startup scan overhead
  ([#2757](https://github.com/loro-dev/lody/issues/2757))
  ([4111c02](https://github.com/loro-dev/lody/commit/4111c0205a7c46eb4ece74d7150979ae5a64e182))

### Refactors

- clarify local-first runtime boundaries
  ([53de04d](https://github.com/loro-dev/lody/commit/53de04d71d686004dcb0479615435ceb8546cc61))
- simplify local-first catalog and IPC transport
  ([5dd6c10](https://github.com/loro-dev/lody/commit/5dd6c10011bf516536b35f4f47bd73a01a57c3a8))

### Documentation

- record 2026-07-04 remediation decisions in local-first plan docs
  ([87387c3](https://github.com/loro-dev/lody/commit/87387c35673a90897219525772463d12a5a35258))
- record the 2026-07-05 second remediation round in the local-first plan
  ([0b73964](https://github.com/loro-dev/lody/commit/0b7396418700a9ecda3adafb0ce0e856d1c38da1))

## [0.70.1](https://github.com/loro-dev/lody/compare/lody-cli-v0.70.0...lody-cli-v0.70.1) (2026-07-17)

### Bug Fixes

- add Kimi Code install dir to ACP PATH
  ([#2928](https://github.com/loro-dev/lody/issues/2928))
  ([dbf43b1](https://github.com/loro-dev/lody/commit/dbf43b1a1833d3e7a78dae82bc3edd03beca3a10))
- await login-shell PATH before ACP spawn
  ([#2925](https://github.com/loro-dev/lody/issues/2925))
  ([1ea91b0](https://github.com/loro-dev/lody/commit/1ea91b00430428d7315edc6ea20c6d333a12f332))
- sync worktree diff stats to session meta
  ([#2923](https://github.com/loro-dev/lody/issues/2923))
  ([195b685](https://github.com/loro-dev/lody/commit/195b6850563effcb043f5c32b1321ef670010563))

## [0.70.0](https://github.com/loro-dev/lody/compare/lody-cli-v0.69.0...lody-cli-v0.70.0) (2026-07-16)

### Features

- add on-demand device resource monitoring
  ([#2849](https://github.com/loro-dev/lody/issues/2849))
  ([393c046](https://github.com/loro-dev/lody/commit/393c04621a1520e1a6380e2e3d56bf9b55c5000c))
- add queue and guide message behavior
  ([#2854](https://github.com/loro-dev/lody/issues/2854))
  ([e75b605](https://github.com/loro-dev/lody/commit/e75b605527fcd2ad5f81c3d054e1ad2a31fdd264))
- integrate acknowledged Codex steer
  ([#2862](https://github.com/loro-dev/lody/issues/2862))
  ([8851d37](https://github.com/loro-dev/lody/commit/8851d37ae1f65558459c6a46556aff2d8446d4fe))
- integrate Codex ACP session updates
  ([#2895](https://github.com/loro-dev/lody/issues/2895))
  ([5d0bf1d](https://github.com/loro-dev/lody/commit/5d0bf1d53a08cef5ec3bd8a8b4848e1b63936a35))
- presence-based machine online status + session status strip
  ([#2857](https://github.com/loro-dev/lody/issues/2857))
  ([dcd176f](https://github.com/loro-dev/lody/commit/dcd176febabc12e640d47699fa5c99792d8731aa))
- refine agent session rendering and usage
  ([6741215](https://github.com/loro-dev/lody/commit/674121524129900473cee975e28cd085492d93d8))
- refresh ACP capabilities automatically
  ([#2897](https://github.com/loro-dev/lody/issues/2897))
  ([36f78ff](https://github.com/loro-dev/lody/commit/36f78ff0df477d13266c9f4ab3c1329e8db2d3bc))

### Bug Fixes

- bound terminal output history
  ([#2889](https://github.com/loro-dev/lody/issues/2889))
  ([fdbb353](https://github.com/loro-dev/lody/commit/fdbb353c0800a573f409b64c02e26465caac5b00))
- derive mirrored runtimes from dependencies
  ([3bb37d9](https://github.com/loro-dev/lody/commit/3bb37d9dcbb10a203375b9ce481892ce56c3c2ba))
- harden local agent host ownership
  ([#2873](https://github.com/loro-dev/lody/issues/2873))
  ([549c807](https://github.com/loro-dev/lody/commit/549c807a7e8147ad78c37845a9800695d0a1c58d))
- ignore Codex commentary in session titles
  ([#2866](https://github.com/loro-dev/lody/issues/2866))
  ([bc8cff2](https://github.com/loro-dev/lody/commit/bc8cff2a4a7c4215110c7c431275e6fc58208ac0))
- improve device resource monitoring
  ([#2864](https://github.com/loro-dev/lody/issues/2864))
  ([9b9f969](https://github.com/loro-dev/lody/commit/9b9f969d571041fe0f545c3960910531e06a4fa4))
- make Electron auth callback transactional
  ([#2907](https://github.com/loro-dev/lody/issues/2907))
  ([e53a795](https://github.com/loro-dev/lody/commit/e53a795eb6f06d26e503a53f04324e611e42eb55))
- prepare acp adapters before cli typecheck
  ([#2852](https://github.com/loro-dev/lody/issues/2852))
  ([f8c6ebe](https://github.com/loro-dev/lody/commit/f8c6ebea7a1bee251a49cf86d82e09873f8a0c66))
- preserve authoritative ACP session defaults
  ([#2894](https://github.com/loro-dev/lody/issues/2894))
  ([7520ce1](https://github.com/loro-dev/lody/commit/7520ce1b9775f27d797c1b268976bef2ddbea896))
- rebuild ACP adapters before CLI dev
  ([#2891](https://github.com/loro-dev/lody/issues/2891))
  ([a6b06c4](https://github.com/loro-dev/lody/commit/a6b06c490b7a861d2c9c898916c3e598ef2866bc))
- republish CLI presence after reconnect
  ([#2869](https://github.com/loro-dev/lody/issues/2869))
  ([3406ae9](https://github.com/loro-dev/lody/commit/3406ae970e6bbb90a87142394ce84d2583603857))

## [0.57.1-next.45](https://github.com/loro-dev/lody/compare/lody-cli-v0.57.1-next.44...lody-cli-v0.57.1-next.45) (2026-07-16)

### Features

- integrate Codex ACP session updates
  ([#2895](https://github.com/loro-dev/lody/issues/2895))
  ([5d0bf1d](https://github.com/loro-dev/lody/commit/5d0bf1d53a08cef5ec3bd8a8b4848e1b63936a35))
- refine agent session rendering and usage
  ([6741215](https://github.com/loro-dev/lody/commit/674121524129900473cee975e28cd085492d93d8))
- refresh ACP capabilities automatically
  ([#2897](https://github.com/loro-dev/lody/issues/2897))
  ([36f78ff](https://github.com/loro-dev/lody/commit/36f78ff0df477d13266c9f4ab3c1329e8db2d3bc))

### Bug Fixes

- bound terminal output history
  ([#2889](https://github.com/loro-dev/lody/issues/2889))
  ([fdbb353](https://github.com/loro-dev/lody/commit/fdbb353c0800a573f409b64c02e26465caac5b00))
- make Electron auth callback transactional
  ([#2907](https://github.com/loro-dev/lody/issues/2907))
  ([e53a795](https://github.com/loro-dev/lody/commit/e53a795eb6f06d26e503a53f04324e611e42eb55))
- preserve authoritative ACP session defaults
  ([#2894](https://github.com/loro-dev/lody/issues/2894))
  ([7520ce1](https://github.com/loro-dev/lody/commit/7520ce1b9775f27d797c1b268976bef2ddbea896))

## [0.69.0](https://github.com/loro-dev/lody/compare/lody-cli-v0.68.1...lody-cli-v0.69.0) (2026-07-10)

### Features

- codex 5 6 ([#2839](https://github.com/loro-dev/lody/issues/2839))
  ([84ffe5f](https://github.com/loro-dev/lody/commit/84ffe5fb3a046b8b889b7428cf9049d50cdcce04))

### Bug Fixes

- recover stale ACP session-not-found prompts
  ([#2819](https://github.com/loro-dev/lody/issues/2819))
  ([0fc48ed](https://github.com/loro-dev/lody/commit/0fc48edd07b37f0e6c33eebba75bb8038a66eff2))
- restore Codex goal banners
  ([#2841](https://github.com/loro-dev/lody/issues/2841))
  ([bd31a54](https://github.com/loro-dev/lody/commit/bd31a54eb536f060add5d1a45d0baddaa22bf83c))
- shorten Codex full access label
  ([#2834](https://github.com/loro-dev/lody/issues/2834))
  ([40fced1](https://github.com/loro-dev/lody/commit/40fced1e41378af7460f448c93dafc84a409f597))

## [0.68.1](https://github.com/loro-dev/lody/compare/lody-cli-v0.68.0...lody-cli-v0.68.1) (2026-07-08)

### Chores

- **lody-cli:** Synchronize lody-clients versions

## [0.68.0](https://github.com/loro-dev/lody/compare/lody-cli-v0.67.3...lody-cli-v0.68.0) (2026-07-07)

### Features

- sync CLI session reads ([#2816](https://github.com/loro-dev/lody/issues/2816))
  ([d4f01a3](https://github.com/loro-dev/lody/commit/d4f01a3ca724351106d1a2e7999ef09bdbae2b54))

### Bug Fixes

- gate builtin provider registration on machine sync
  ([#2812](https://github.com/loro-dev/lody/issues/2812))
  ([cad5dff](https://github.com/loro-dev/lody/commit/cad5dff8ce9827554a8f73019f9ce9415d165991))
- retry machine flock sync in background
  ([#2815](https://github.com/loro-dev/lody/issues/2815))
  ([7c3068c](https://github.com/loro-dev/lody/commit/7c3068cb573e32ba0958898fc164afd8f189d995))
- separate ACP static capabilities from runtime refresh
  ([#2814](https://github.com/loro-dev/lody/issues/2814))
  ([6193eee](https://github.com/loro-dev/lody/commit/6193eee8b310cd65fd3f41e90af72622d17757fc))

## [0.67.3](https://github.com/loro-dev/lody/compare/lody-cli-v0.67.2...lody-cli-v0.67.3) (2026-07-07)

### Bug Fixes

- release trigger
  ([bbabba0](https://github.com/loro-dev/lody/commit/bbabba06ad7018a00b6496d73dfa9323d4ed5915))

## [0.67.2](https://github.com/loro-dev/lody/compare/lody-cli-v0.67.1...lody-cli-v0.67.2) (2026-07-07)

### Chores

- **lody-cli:** Synchronize lody-clients versions

## [0.67.1](https://github.com/loro-dev/lody/compare/lody-cli-v0.67.0...lody-cli-v0.67.1) (2026-07-07)

### Chores

- **lody-cli:** Synchronize lody-clients versions

## [0.67.0](https://github.com/loro-dev/lody/compare/lody-cli-v0.66.1...lody-cli-v0.67.0) (2026-07-07)

### Features

- keep sessions alive after turn_end + pending scheduled tasks UI
  ([#2762](https://github.com/loro-dev/lody/issues/2762))
  ([40ed3ea](https://github.com/loro-dev/lody/commit/40ed3ea6bbc0b20130a718341738ff7f4863c93c))
- keep sessions alive after turn_end + pending scheduled-tasks panel
  ([#2771](https://github.com/loro-dev/lody/issues/2771))
  ([b5ea62b](https://github.com/loro-dev/lody/commit/b5ea62bf04aebd8df1a4934663738b398b895a7b))
- optimize cli prompt hot path
  ([#2772](https://github.com/loro-dev/lody/issues/2772))
  ([5fc7190](https://github.com/loro-dev/lody/commit/5fc7190abd152e06c9dd6ced705755615a48ff50))

### Bug Fixes

- build vendored acp adapters before cli bundle
  ([#2795](https://github.com/loro-dev/lody/issues/2795))
  ([cbf974c](https://github.com/loro-dev/lody/commit/cbf974ca622f56ff282f71e04d231663d83e343f))
- builtin ACP capability refresh
  ([#2798](https://github.com/loro-dev/lody/issues/2798))
  ([c3b408c](https://github.com/loro-dev/lody/commit/c3b408c1085a37d223d21ffa67690f754efc79a9))
- clear session presence after turns
  ([#2767](https://github.com/loro-dev/lody/issues/2767))
  ([83cb038](https://github.com/loro-dev/lody/commit/83cb0387cfa046cd30e9cfe9bd1d85ddb45b14f5))
- **cli:** centralize session active presence
  ([#2768](https://github.com/loro-dev/lody/issues/2768))
  ([be90426](https://github.com/loro-dev/lody/commit/be90426cbae87e73f0a3f01ed6530943a4ea4014))
- gate RPC fast-path turn output behind user-turn history sync
  ([#2766](https://github.com/loro-dev/lody/issues/2766))
  ([26b1131](https://github.com/loro-dev/lody/commit/26b1131b96ce216979d6acfca949b45cbb3ece06))
- improve managed runtime onboarding
  ([#2788](https://github.com/loro-dev/lody/issues/2788))
  ([b1bf057](https://github.com/loro-dev/lody/commit/b1bf057f100d6733917d0d0f23b8d149114b6959))
- make session working presence heartbeat foolproof
  ([#2759](https://github.com/loro-dev/lody/issues/2759))
  ([93fb0fe](https://github.com/loro-dev/lody/commit/93fb0fe85289061bc13a5aaeb72363ff346b0677))
- pass system proxy to managed runtime downloads
  ([#2797](https://github.com/loro-dev/lody/issues/2797))
  ([999e96b](https://github.com/loro-dev/lody/commit/999e96b45496aa1c8c532219d8c64aa8a28f2060))

## [0.57.1-next.40](https://github.com/loro-dev/lody/compare/lody-cli-v0.57.1-next.39...lody-cli-v0.57.1-next.40) (2026-07-07)

### Bug Fixes

- pass system proxy to managed runtime downloads
  ([#2797](https://github.com/loro-dev/lody/issues/2797))
  ([999e96b](https://github.com/loro-dev/lody/commit/999e96b45496aa1c8c532219d8c64aa8a28f2060))

## [0.57.1-next.39](https://github.com/loro-dev/lody/compare/lody-cli-v0.57.1-next.38...lody-cli-v0.57.1-next.39) (2026-07-07)

### Bug Fixes

- build vendored acp adapters before cli bundle
  ([#2795](https://github.com/loro-dev/lody/issues/2795))
  ([cbf974c](https://github.com/loro-dev/lody/commit/cbf974ca622f56ff282f71e04d231663d83e343f))

## [0.57.1-next.38](https://github.com/loro-dev/lody/compare/lody-cli-v0.57.1-next.37...lody-cli-v0.57.1-next.38) (2026-07-07)

### Bug Fixes

- improve managed runtime onboarding
  ([#2788](https://github.com/loro-dev/lody/issues/2788))
  ([b1bf057](https://github.com/loro-dev/lody/commit/b1bf057f100d6733917d0d0f23b8d149114b6959))

## [0.57.1-next.37](https://github.com/loro-dev/lody/compare/lody-cli-v0.57.1-next.36...lody-cli-v0.57.1-next.37) (2026-07-06)

### Features

- keep sessions alive after turn_end + pending scheduled tasks UI
  ([#2762](https://github.com/loro-dev/lody/issues/2762))
  ([40ed3ea](https://github.com/loro-dev/lody/commit/40ed3ea6bbc0b20130a718341738ff7f4863c93c))
- keep sessions alive after turn_end + pending scheduled-tasks panel
  ([#2771](https://github.com/loro-dev/lody/issues/2771))
  ([b5ea62b](https://github.com/loro-dev/lody/commit/b5ea62bf04aebd8df1a4934663738b398b895a7b))
- optimize cli prompt hot path
  ([#2772](https://github.com/loro-dev/lody/issues/2772))
  ([5fc7190](https://github.com/loro-dev/lody/commit/5fc7190abd152e06c9dd6ced705755615a48ff50))

### Bug Fixes

- clear session presence after turns
  ([#2767](https://github.com/loro-dev/lody/issues/2767))
  ([83cb038](https://github.com/loro-dev/lody/commit/83cb0387cfa046cd30e9cfe9bd1d85ddb45b14f5))
- **cli:** centralize session active presence
  ([#2768](https://github.com/loro-dev/lody/issues/2768))
  ([be90426](https://github.com/loro-dev/lody/commit/be90426cbae87e73f0a3f01ed6530943a4ea4014))
- gate RPC fast-path turn output behind user-turn history sync
  ([#2766](https://github.com/loro-dev/lody/issues/2766))
  ([26b1131](https://github.com/loro-dev/lody/commit/26b1131b96ce216979d6acfca949b45cbb3ece06))
- make session working presence heartbeat foolproof
  ([#2759](https://github.com/loro-dev/lody/issues/2759))
  ([93fb0fe](https://github.com/loro-dev/lody/commit/93fb0fe85289061bc13a5aaeb72363ff346b0677))

### Performance

- reduce flock startup scan overhead
  ([#2757](https://github.com/loro-dev/lody/issues/2757))
  ([4111c02](https://github.com/loro-dev/lody/commit/4111c0205a7c46eb4ece74d7150979ae5a64e182))

## [0.57.1-next.36](https://github.com/loro-dev/lody/compare/lody-cli-v0.57.1-next.35...lody-cli-v0.57.1-next.36) (2026-07-02)

### Bug Fixes

- Fix CLI auth fetch over HTTP transport
  ([#2742](https://github.com/loro-dev/lody/issues/2742))
  ([d627d52](https://github.com/loro-dev/lody/commit/d627d522713a8ae81b6a98ac04c48010c89f80f8))
- improve CLI startup diagnostics
  ([#2747](https://github.com/loro-dev/lody/issues/2747))
  ([1a6d9cb](https://github.com/loro-dev/lody/commit/1a6d9cb0ebeb8bc808bfd8483f0b5d399f15ab40))
- reduce session dispatch latency (ChatLanding → CLI fast path)
  ([#2754](https://github.com/loro-dev/lody/issues/2754))
  ([6bc018f](https://github.com/loro-dev/lody/commit/6bc018f015809d107ae5f46be72c63b18a694709))
- remove full access mode
  ([#2752](https://github.com/loro-dev/lody/issues/2752))
  ([0e1f856](https://github.com/loro-dev/lody/commit/0e1f856bcfd34fac46c42e605daae21da5016ada))
- skip worktree setup on session restore
  ([#2751](https://github.com/loro-dev/lody/issues/2751))
  ([f2f0be9](https://github.com/loro-dev/lody/commit/f2f0be929a907e3b46e5f60471f864aa85dd71c7))

## [0.57.1-next.35](https://github.com/loro-dev/lody/compare/lody-cli-v0.57.1-next.34...lody-cli-v0.57.1-next.35) (2026-07-01)

### Features

- show Claude Code `fast` config option like Codex fast-mode
  ([#2727](https://github.com/loro-dev/lody/issues/2727))
  ([a8438bf](https://github.com/loro-dev/lody/commit/a8438bf35477b44e0ad1ff79852e837384f25bd8))

### Bug Fixes

- add session dispatch startup diagnostics
  ([#2728](https://github.com/loro-dev/lody/issues/2728))
  ([e184d5d](https://github.com/loro-dev/lody/commit/e184d5db4998338cba8c0a3fd237579d500b79a6))
- agent config storage and install setup
  ([#2737](https://github.com/loro-dev/lody/issues/2737))
  ([9cdc08e](https://github.com/loro-dev/lody/commit/9cdc08e3bc99b2c7a0c64392c0febfdb6abc0aac))
- follow release version for iOS App Store release
  ([#2726](https://github.com/loro-dev/lody/issues/2726))
  ([a8438bf](https://github.com/loro-dev/lody/commit/a8438bf35477b44e0ad1ff79852e837384f25bd8))
- Isolate session bootstrap from workspace startup
  ([#2731](https://github.com/loro-dev/lody/issues/2731))
  ([d1b2d56](https://github.com/loro-dev/lody/commit/d1b2d567985a0eaae7a4e0fa74377848e6288f80))
- manage builtin agent runtimes
  ([#2724](https://github.com/loro-dev/lody/issues/2724))
  ([d1d6713](https://github.com/loro-dev/lody/commit/d1d671320d9459c60267ac659dc3c78b2fe58a95))
- relax Loro Streams RPC connect timeout
  ([#2734](https://github.com/loro-dev/lody/issues/2734))
  ([5194fff](https://github.com/loro-dev/lody/commit/5194fffe9b81d271fff0116feacf40bc5987bab6))
- show newly-created agent providers from machine flock
  ([#2740](https://github.com/loro-dev/lody/issues/2740))
  ([d8cbed3](https://github.com/loro-dev/lody/commit/d8cbed3bb9fab60e76311f989e09bc6140627e83))

## [0.66.1](https://github.com/loro-dev/lody/compare/lody-cli-v0.66.0...lody-cli-v0.66.1) (2026-07-03)

### Bug Fixes

- release trigger
  ([5f98e92](https://github.com/loro-dev/lody/commit/5f98e92f0a30aa978bbff2281ed545a38be37220))

## [0.66.0](https://github.com/loro-dev/lody/compare/lody-cli-v0.65.0...lody-cli-v0.66.0) (2026-07-01)

### Features

- show Claude Code `fast` config option like Codex fast-mode
  ([#2727](https://github.com/loro-dev/lody/issues/2727))
  ([a17db18](https://github.com/loro-dev/lody/commit/a17db18fac98b763df2dffc34bc90b690f633924))

### Bug Fixes

- add session dispatch startup diagnostics
  ([#2728](https://github.com/loro-dev/lody/issues/2728))
  ([fe19768](https://github.com/loro-dev/lody/commit/fe19768a4da77c2ba804777ddbd13d99d74668cf))
- follow release version for iOS App Store release
  ([#2726](https://github.com/loro-dev/lody/issues/2726))
  ([a17db18](https://github.com/loro-dev/lody/commit/a17db18fac98b763df2dffc34bc90b690f633924))
- Isolate session bootstrap from workspace startup
  ([#2731](https://github.com/loro-dev/lody/issues/2731))
  ([d345432](https://github.com/loro-dev/lody/commit/d3454324f23d31570c496d885480b08787c67150))
- restore pre-release verification gates
  ([294086a](https://github.com/loro-dev/lody/commit/294086ad9ba46678abb92ff4b64826907ab721c1))

## [0.65.0](https://github.com/loro-dev/lody/compare/lody-cli-v0.64.2...lody-cli-v0.65.0) (2026-06-30)

### Features

- add bug report flow with machine log upload
  ([#2434](https://github.com/loro-dev/lody/issues/2434))
  ([f36714e](https://github.com/loro-dev/lody/commit/f36714ecf3986162ee6a725418fb62f2d6ac38e5))
- add daily auth activity rollup
  ([#2491](https://github.com/loro-dev/lody/issues/2491))
  ([6347014](https://github.com/loro-dev/lody/commit/6347014037091a6f70c53d1eb675dede191331e8))
- add embedded terminal ([#2396](https://github.com/loro-dev/lody/issues/2396))
  ([cff0f68](https://github.com/loro-dev/lody/commit/cff0f68fa58cb96071e763f21f1f80091a8ef271))
- add kimi code registry agent
  ([#2343](https://github.com/loro-dev/lody/issues/2343))
  ([a7e6323](https://github.com/loro-dev/lody/commit/a7e63236a36cda780d2fcf887f5939537226acc1))
- add project file browsing for GitHub and local projects
  ([#2357](https://github.com/loro-dev/lody/issues/2357))
  ([a0a571c](https://github.com/loro-dev/lody/commit/a0a571c497124f2bde34da54079771f93b416a76))
- add session copy submenu
  ([#2600](https://github.com/loro-dev/lody/issues/2600))
  ([eaa731a](https://github.com/loro-dev/lody/commit/eaa731a8e0bd827a470d2fed17f3651cdfa85af8))
- add worktree cleanup scripts
  ([ca2d40c](https://github.com/loro-dev/lody/commit/ca2d40cadc0b3750d815b3725a893b13e45a8995))
- add worktree setup scripts
  ([9156eca](https://github.com/loro-dev/lody/commit/9156ecad2f88ea4ffecb72f80aa2b54fc137a0cf))
- **cli:** acp-extension-claude 0.44.0 (AskUserQuestion elicitation) +
  @agentclientprotocol/sdk 0.25.0
  ([#2397](https://github.com/loro-dev/lody/issues/2397))
  ([351ab97](https://github.com/loro-dev/lody/commit/351ab97776836f15be2ff45f1361aad6d9e270c0))
- **cli:** add local project worktree create option
  ([#2459](https://github.com/loro-dev/lody/issues/2459))
  ([8d1c8ee](https://github.com/loro-dev/lody/commit/8d1c8ee05231a63e85f364d7b4a53735cf907ac5))
- **cli:** capture turn diffs purely from ACP-visible agent edits
  ([c57dcd1](https://github.com/loro-dev/lody/commit/c57dcd12debac2ede89161703390dfdbdb3f9f7c))
- **cli:** fall back to turn-start commit for missing per-turn bases
  ([28cfe67](https://github.com/loro-dev/lody/commit/28cfe675bf9526a61b295bd237c825032caa2c32))
- **cli:** nudge the agent toward Lody MCP tools in the turn prompt
  ([#2489](https://github.com/loro-dev/lody/issues/2489))
  ([2c33397](https://github.com/loro-dev/lody/commit/2c33397201a71a335e63cdbb5fd5ba668dbed08a))
- **cli:** reconstruct edit-tool turn captures verified against disk
  ([af77e03](https://github.com/loro-dev/lody/commit/af77e038d6c4b9e8dcbc41ce69f4b9f199e7a549))
- **cli:** record child-session turn diffs via parent Code Collab host
  ([#2454](https://github.com/loro-dev/lody/issues/2454))
  ([1139421](https://github.com/loro-dev/lody/commit/11394216c15966f06cc00c2268c224747b717d2c))
- **cli:** stop writing heartbeat timestamps to meta, rely on ephemeral presence
  ([#2449](https://github.com/loro-dev/lody/issues/2449))
  ([631afe6](https://github.com/loro-dev/lody/commit/631afe6ac2c29558971117694a8834f6d1d456e7))
- **code-collab:** publish All Changes text checkpoints in file metadata
  ([2a34475](https://github.com/loro-dev/lody/commit/2a344751fb0647cc059542869cccb17df80e39d2))
- **components:** cross-platform command + hotkey registry
  ([#2087](https://github.com/loro-dev/lody/issues/2087))
  ([e4c110e](https://github.com/loro-dev/lody/commit/e4c110eaad2f1bc50a58a583b334dd5717b5548d))
- expand skill mentions in prompts
  ([#2608](https://github.com/loro-dev/lody/issues/2608))
  ([6c4a061](https://github.com/loro-dev/lody/commit/6c4a061c9d80a783ea8e1c5bb9c34c79baab952e))
- handle live activity permission actions
  ([a2fb1dd](https://github.com/loro-dev/lody/commit/a2fb1dd2023c162592c0eb57f4cc850c4a865dc1))
- **pr:** add Draft pull request status with icon and display
  ([#2541](https://github.com/loro-dev/lody/issues/2541))
  ([8d7c9ee](https://github.com/loro-dev/lody/commit/8d7c9ee02c03870a0a0c4e7ab784c0dc881de556))
- preview image files in the mobile file browser
  ([#2479](https://github.com/loro-dev/lody/issues/2479))
  ([484cef1](https://github.com/loro-dev/lody/commit/484cef1462a8918a3ea84a78cbcf8a11cf68b19a))
- record worktree script output history
  ([201f3b0](https://github.com/loro-dev/lody/commit/201f3b0607516d2ffbeb4a8c7eed331207501452))
- rewrite Code Collab v2 ([#2516](https://github.com/loro-dev/lody/issues/2516))
  ([ce83943](https://github.com/loro-dev/lody/commit/ce839431dac24f7407e3d51fec93379ce349b698))
- session file attachments across web, desktop, mobile, CLI, and agents
  ([#2451](https://github.com/loro-dev/lody/issues/2451))
  ([d87c6ad](https://github.com/loro-dev/lody/commit/d87c6ad1b365651c60ee4df978e9f977d5500681))
- split worktree script history by command
  ([8b6270f](https://github.com/loro-dev/lody/commit/8b6270f15c5f99646563c1e1c25f56d774ee35d1))
- support image drag-and-drop anywhere in session interface
  ([#2524](https://github.com/loro-dev/lody/issues/2524))
  ([65b4f83](https://github.com/loro-dev/lody/commit/65b4f8333bbc7c175ba5a9b00419ae7401408357))
- support user-defined custom ACP providers
  ([#2400](https://github.com/loro-dev/lody/issues/2400))
  ([07fd724](https://github.com/loro-dev/lody/commit/07fd7246af66c74a3c23c4e234e617455af97240))
- top-level `## Review` findings with multi-location jumps
  ([#2533](https://github.com/loro-dev/lody/issues/2533))
  ([f7aaf01](https://github.com/loro-dev/lody/commit/f7aaf0173aedccb2393bf3703a1feeabb2011861))

### Bug Fixes

- add Code Collab file save shortcut
  ([#2550](https://github.com/loro-dev/lody/issues/2550))
  ([2ccc37a](https://github.com/loro-dev/lody/commit/2ccc37a2181125bf21283ddbe97f64a22036c819))
- add code review helper package
  ([#2509](https://github.com/loro-dev/lody/issues/2509))
  ([3a575ec](https://github.com/loro-dev/lody/commit/3a575ec335ffa543072dab3440d71d0be8c128d8))
- align CLI diffStats with PR compare
  ([#2464](https://github.com/loro-dev/lody/issues/2464))
  ([528bbeb](https://github.com/loro-dev/lody/commit/528bbeb2f6154df63c8252c82a09732510b35731))
- apply live activity permission responses via loro
  ([f1ba461](https://github.com/loro-dev/lody/commit/f1ba461b1d1c3e31f2fb8a1bac30c348cf13221e))
- auth
  ([55fe36d](https://github.com/loro-dev/lody/commit/55fe36d55b0637524d967f7fb58147c82fb90bbd))
- bound Code Collab diff requests
  ([#2565](https://github.com/loro-dev/lody/issues/2565))
  ([6c533c4](https://github.com/loro-dev/lody/commit/6c533c480217542b2842f6250a4a9836b3fe1018))
- capture git turn diffs from full branch delta
  ([ffec31b](https://github.com/loro-dev/lody/commit/ffec31bebfb56de3ca6dd3b2f362db62cc17f00b))
- **cli:** auto re-bootstrap stale CLI credentials after Electron login
  ([#2498](https://github.com/loro-dev/lody/issues/2498))
  ([4fe9325](https://github.com/loro-dev/lody/commit/4fe932592b3f2e41b6646f8305e2c7e55b8712a1))
- **cli:** avoid bundled ESM require hook crashes
  ([#2361](https://github.com/loro-dev/lody/issues/2361))
  ([daefe7e](https://github.com/loro-dev/lody/commit/daefe7ee4abb62ae3a341059ade42350c60c03f5))
- **cli:** capture Claude Code edit evidence from in-progress ACP updates
  ([#2421](https://github.com/loro-dev/lody/issues/2421))
  ([0b82d9a](https://github.com/loro-dev/lody/commit/0b82d9a4a428003c9a50885ad7d9ebfeb1b02f61))
- **cli:** fall back to legacy NewSessionResponse.models for ACP agents without
  config options ([#2522](https://github.com/loro-dev/lody/issues/2522))
  ([ba36076](https://github.com/loro-dev/lody/commit/ba36076d25c3267fad95fc9eb2f45c4d3e12273b))
- **cli:** guard session diff stats writers
  ([#2515](https://github.com/loro-dev/lody/issues/2515))
  ([efe4b46](https://github.com/loro-dev/lody/commit/efe4b4630f059bb9bdba618ec90f36f8eda8f200))
- **cli:** persist Code Collab fileDiff for failed turns
  ([7aca1e4](https://github.com/loro-dev/lody/commit/7aca1e4506479af0bc3462b11432cbfd5a4ba123))
- **cli:** retry session image downloads before prompt
  ([#2525](https://github.com/loro-dev/lody/issues/2525))
  ([99231e3](https://github.com/loro-dev/lody/commit/99231e33e2bb854770f30ec3ff684c629901adf2))
- **cli:** scope code collab turn history diffs
  ([fdb9509](https://github.com/loro-dev/lody/commit/fdb95091719a352f959230c2ca9ebfc6a9ad94f7))
- **cli:** skip completion notification when user manually stops a turn
  ([#2539](https://github.com/loro-dev/lody/issues/2539))
  ([ceac0b8](https://github.com/loro-dev/lody/commit/ceac0b8954ab4e56c962f98ec01586945b03d2fe))
- Code Collab v2 turn diffs and file diff cache
  ([#2546](https://github.com/loro-dev/lody/issues/2546))
  ([b9015f5](https://github.com/loro-dev/lody/commit/b9015f51dd5ea23930a00b46862308f75d574b8d))
- **code-collab:** stabilize scenario disk change tests
  ([669d9c9](https://github.com/loro-dev/lody/commit/669d9c94e395b4d75f133e4beebb868a85b196d6))
- compute turn-diff line counts with a git-matching line diff
  ([#2602](https://github.com/loro-dev/lody/issues/2602))
  ([f208a30](https://github.com/loro-dev/lody/commit/f208a3087174adb1f559a70f5ff41ee0cca5eb3d))
- dispatch CLI machine RPC requests concurrently
  ([#2609](https://github.com/loro-dev/lody/issues/2609))
  ([8308955](https://github.com/loro-dev/lody/commit/8308955beaeab868036cdbc6d289e0c56df376dc))
- fallback permission push after live activity failure
  ([c5d1302](https://github.com/loro-dev/lody/commit/c5d1302ad5408577d1a716c1ac5f318e3c8e4753))
- filter unsupported `agent` ACP config option
  ([#2623](https://github.com/loro-dev/lody/issues/2623))
  ([941de42](https://github.com/loro-dev/lody/commit/941de42ab8346875e52c5ca77ca6f160eaff1526))
- infer worktree scripts from content
  ([7ad0007](https://github.com/loro-dev/lody/commit/7ad000728fccea1e5d510d0d8dc5a92cd3095f4a))
- isolate ACP npx npm cache
  ([#2526](https://github.com/loro-dev/lody/issues/2526))
  ([ddca1af](https://github.com/loro-dev/lody/commit/ddca1af048d02421780804704ad7a0321fc377fd))
- Isolate Code Collab shared-state renders
  ([#2571](https://github.com/loro-dev/lody/issues/2571))
  ([33c0cb3](https://github.com/loro-dev/lody/commit/33c0cb381a6d82e4420f7dc47ccf263cb13dbd2d))
- Isolate presence streams
  ([#2562](https://github.com/loro-dev/lody/issues/2562))
  ([9809cc1](https://github.com/loro-dev/lody/commit/9809cc19496e55b5eb44e9e5b184bc5fadd84446))
- keep worktree script history separate
  ([82f0cf1](https://github.com/loro-dev/lody/commit/82f0cf1364d64742b57688223188723e7549c2a7))
- lock down public convex surfaces
  ([#2674](https://github.com/loro-dev/lody/issues/2674))
  ([e381bc6](https://github.com/loro-dev/lody/commit/e381bc6fc51d6be91b8fbbd6291650582480280e))
- make file index changes authoritative
  ([#2463](https://github.com/loro-dev/lody/issues/2463))
  ([1236e3e](https://github.com/loro-dev/lody/commit/1236e3e8040219dd54fe1f11d06438fe8a268f30))
- package embedded cli node-pty
  ([#2476](https://github.com/loro-dev/lody/issues/2476))
  ([4bba3b3](https://github.com/loro-dev/lody/commit/4bba3b3ff3de0b1636fed717ee0a50b346e1ce1c))
- Preserve assistant entry ownership for ACP updates
  ([#2561](https://github.com/loro-dev/lody/issues/2561))
  ([c3fde0f](https://github.com/loro-dev/lody/commit/c3fde0f6e2ae1e45a1c858fa0b3626169c4c239e))
- preserve code collab text frontiers
  ([acc08e7](https://github.com/loro-dev/lody/commit/acc08e7829a08bf2a95d9641f1f8387d2cbca552))
- preserve shared worktree setup history
  ([bda82bb](https://github.com/loro-dev/lody/commit/bda82bb5fe384b347385dd3c1165b73e69a8c672))
- prevent loro reconnect storm
  ([#2468](https://github.com/loro-dev/lody/issues/2468))
  ([9bf83f1](https://github.com/loro-dev/lody/commit/9bf83f1ebaaa79418125f416d42059af372915c1))
- publish loro-crdt as CLI runtime dependency
  ([#2363](https://github.com/loro-dev/lody/issues/2363))
  ([8e81146](https://github.com/loro-dev/lody/commit/8e81146ed3e80350a686eaec611c6a475e20da8c))
- recover closed ACP sessions
  ([#2391](https://github.com/loro-dev/lody/issues/2391))
  ([34fab79](https://github.com/loro-dev/lody/commit/34fab79213ecd15d9223d8de0df02981929added))
- recover cold npx ACP startup
  ([#2660](https://github.com/loro-dev/lody/issues/2660))
  ([7ea3ea1](https://github.com/loro-dev/lody/commit/7ea3ea19c959e113c163e7d9e541e9d41937d053))
- recover cold npx ACP startup
  ([#2660](https://github.com/loro-dev/lody/issues/2660))
  ([1d50da3](https://github.com/loro-dev/lody/commit/1d50da3b848957c31a253705e1b545c8062ec633))
- relax heartbeat offline window and move file index work off-thread
  ([#2653](https://github.com/loro-dev/lody/issues/2653))
  ([60c32a4](https://github.com/loro-dev/lody/commit/60c32a463006ed750b477f150f4ffcda4ef9e770))
- relax heartbeat offline window and move file index work off-thread
  ([#2653](https://github.com/loro-dev/lody/issues/2653))
  ([ce8562c](https://github.com/loro-dev/lody/commit/ce8562c232a598fd38741357782b0c7fc0470326))
- release trigger
  ([d466c34](https://github.com/loro-dev/lody/commit/d466c34be44a01d124312cd02a990ed9decc0eff))
- release trigger
  ([0fdcd0b](https://github.com/loro-dev/lody/commit/0fdcd0b02c85e2d3f32746e3be8661aaa9a54657))
- remove diffStats file list
  ([#2457](https://github.com/loro-dev/lody/issues/2457))
  ([7da0bfa](https://github.com/loro-dev/lody/commit/7da0bfaa259fcc1105591f247b6cdedd43251731))
- remove Lody-injected Full Access mode
  ([#2598](https://github.com/loro-dev/lody/issues/2598))
  ([a6b0cd1](https://github.com/loro-dev/lody/commit/a6b0cd1923339f7ad967b8a46abe0813949175e8))
- render worktree scripts as system history
  ([a13e88e](https://github.com/loro-dev/lody/commit/a13e88ee70b12affefa7425ff7ed4c35802763f1))
- repair Code Collab turn diffs & All Changes
  ([#2337](https://github.com/loro-dev/lody/issues/2337))
  ([a2e84a4](https://github.com/loro-dev/lody/commit/a2e84a4252611e3412cc94ac07ce493a92e271ee))
- restore code collab lazy file indexing
  ([#2557](https://github.com/loro-dev/lody/issues/2557))
  ([371907f](https://github.com/loro-dev/lody/commit/371907fffef40bbe7683d62f822aa834cb421876))
- retry transient CLI auth validation failures
  ([#2358](https://github.com/loro-dev/lody/issues/2358))
  ([24bfaf7](https://github.com/loro-dev/lody/commit/24bfaf79e7b9c02f0e0b9b0de55ccbf1cdda8b88))
- reuse parent workdir for chat child tabs
  ([#2555](https://github.com/loro-dev/lody/issues/2555))
  ([4b20e64](https://github.com/loro-dev/lody/commit/4b20e64b37f9c93e7e9d783675b5e4d84754c4c3))
- satisfy lint and safe-area tests
  ([00e84f8](https://github.com/loro-dev/lody/commit/00e84f89c06e1f3906a736d0e81116b2d0b2b1e7))
- session attachment ACP flow
  ([#2588](https://github.com/loro-dev/lody/issues/2588))
  ([4118b18](https://github.com/loro-dev/lody/commit/4118b18ecc4e45af295cd50128dcba751623ea60))
- show worktree command in nested terminal
  ([08f09a7](https://github.com/loro-dev/lody/commit/08f09a78b9705e142576d03e31456db59f1308af))
- show worktree script command
  ([b832656](https://github.com/loro-dev/lody/commit/b83265625c2516fb3df1ffc81ee47a446ff7645a))
- speed up code collab turn diff persistence
  ([#2460](https://github.com/loro-dev/lody/issues/2460))
  ([82de68e](https://github.com/loro-dev/lody/commit/82de68e0f97a951162ab0d64b7ff103048dbde4b))
- stabilize code collab diff tracking
  ([ce68961](https://github.com/loro-dev/lody/commit/ce689612bdffec73b590e29c92af2ba056af4a9d))
- store code collab file index in flock
  ([#2618](https://github.com/loro-dev/lody/issues/2618))
  ([b3b7951](https://github.com/loro-dev/lody/commit/b3b79517c90ffb3241db0c0cdd3865254aacde39))
- support remote worktree setup control
  ([1b7ac3a](https://github.com/loro-dev/lody/commit/1b7ac3a56b5efe0fdc844330cb57fe24867db9d6))
- sync Code Collab turn diff snapshots
  ([#2511](https://github.com/loro-dev/lody/issues/2511))
  ([670b941](https://github.com/loro-dev/lody/commit/670b94161b79156f2154240052a152f543dfc5de))
- **test:** align integration tests with ACP-visible edit capture
  ([b93d3d0](https://github.com/loro-dev/lody/commit/b93d3d0cfe1a155d43901cfaa0613634ed25a412))
- upgrade node-pty for Windows CI
  ([#2484](https://github.com/loro-dev/lody/issues/2484))
  ([b9a51b7](https://github.com/loro-dev/lody/commit/b9a51b7ca924f6d7648e6f5ad2e64f9ff3708e10))
- upgrade node-pty for Windows CI
  ([#2484](https://github.com/loro-dev/lody/issues/2484))
  ([5bff434](https://github.com/loro-dev/lody/commit/5bff434dced06f2b434e5393952b450d49007172))
- wait for permission history before live activity
  ([#2382](https://github.com/loro-dev/lody/issues/2382))
  ([c88bf42](https://github.com/loro-dev/lody/commit/c88bf427c8335dda0b259bcef90b97f92ecbb4c8))
- wrap session file upload streams for R2
  ([#2585](https://github.com/loro-dev/lody/issues/2585))
  ([4697045](https://github.com/loro-dev/lody/commit/46970453afd32b79695b737a7807e46393f0de22))

### Refactors

- dedupe live activity permission + convex url helpers into shared
  ([1af2140](https://github.com/loro-dev/lody/commit/1af2140ec1abf48ff10e6b0e3c3ca0346ed40390))
- redesign worktree setup settings UI
  ([61c4087](https://github.com/loro-dev/lody/commit/61c40873511d3d57ca6c625dba0957fb36ee3c1e))
- reduce worktree config duplication
  ([c6e5596](https://github.com/loro-dev/lody/commit/c6e5596a0127b9d4437340a7e8aedaa288e1c247))

### Documentation

- **cli:** add AGENTS.md noting ACP adapter source repos
  ([#2422](https://github.com/loro-dev/lody/issues/2422))
  ([8a90160](https://github.com/loro-dev/lody/commit/8a90160b8f6f25df53269e990da2d93fd5c4f184))
- **cli:** document GitHub auth shortcut
  ([#2517](https://github.com/loro-dev/lody/issues/2517))
  ([2e4a485](https://github.com/loro-dev/lody/commit/2e4a4859bc6287c0171b2d5eae84a882b31f376a))
- **cli:** make `lody review` self-explanatory to AI agents
  ([#2531](https://github.com/loro-dev/lody/issues/2531))
  ([dafaaa8](https://github.com/loro-dev/lody/commit/dafaaa8fb8339ec14059da67ab7cc5c963df2de9))
- **context:** add implementation discovery guides
  ([#2458](https://github.com/loro-dev/lody/issues/2458))
  ([0de9fd1](https://github.com/loro-dev/lody/commit/0de9fd144ad21b9bf7fcc8e72be5d4ef892aa343))
- design for remote add-local-project directory picker
  ([#2387](https://github.com/loro-dev/lody/issues/2387))
  ([1904c14](https://github.com/loro-dev/lody/commit/1904c14d6f81b00cd5dab6ff146bc6e3a3f18e1d))

## [0.63.3](https://github.com/loro-dev/lody/compare/lody-cli-v0.63.2...lody-cli-v0.63.3) (2026-06-25)

### Bug Fixes

- recover cold npx ACP startup
  ([#2660](https://github.com/loro-dev/lody/issues/2660))
  ([7ea3ea1](https://github.com/loro-dev/lody/commit/7ea3ea19c959e113c163e7d9e541e9d41937d053))
- recover cold npx ACP startup
  ([#2660](https://github.com/loro-dev/lody/issues/2660))
  ([1d50da3](https://github.com/loro-dev/lody/commit/1d50da3b848957c31a253705e1b545c8062ec633))
- relax heartbeat offline window and move file index work off-thread
  ([#2653](https://github.com/loro-dev/lody/issues/2653))
  ([60c32a4](https://github.com/loro-dev/lody/commit/60c32a463006ed750b477f150f4ffcda4ef9e770))
- relax heartbeat offline window and move file index work off-thread
  ([#2653](https://github.com/loro-dev/lody/issues/2653))
  ([ce8562c](https://github.com/loro-dev/lody/commit/ce8562c232a598fd38741357782b0c7fc0470326))

## [0.63.2](https://github.com/loro-dev/lody/compare/lody-cli-v0.63.1...lody-cli-v0.63.2) (2026-06-24)

### Chores

- **lody-cli:** Synchronize lody-clients versions

## [0.63.1](https://github.com/loro-dev/lody/compare/lody-cli-v0.63.0...lody-cli-v0.63.1) (2026-06-24)

### Chores

- **lody-cli:** Synchronize lody-clients versions

## [0.63.0](https://github.com/loro-dev/lody/compare/lody-cli-v0.62.0...lody-cli-v0.63.0) (2026-06-24)

### Features

- add session copy submenu
  ([#2600](https://github.com/loro-dev/lody/issues/2600))
  ([eaa731a](https://github.com/loro-dev/lody/commit/eaa731a8e0bd827a470d2fed17f3651cdfa85af8))
- **components:** cross-platform command + hotkey registry
  ([#2087](https://github.com/loro-dev/lody/issues/2087))
  ([e4c110e](https://github.com/loro-dev/lody/commit/e4c110eaad2f1bc50a58a583b334dd5717b5548d))
- expand skill mentions in prompts
  ([#2608](https://github.com/loro-dev/lody/issues/2608))
  ([6c4a061](https://github.com/loro-dev/lody/commit/6c4a061c9d80a783ea8e1c5bb9c34c79baab952e))
- **pr:** add Draft pull request status with icon and display
  ([#2541](https://github.com/loro-dev/lody/issues/2541))
  ([8d7c9ee](https://github.com/loro-dev/lody/commit/8d7c9ee02c03870a0a0c4e7ab784c0dc881de556))
- rewrite Code Collab v2 ([#2516](https://github.com/loro-dev/lody/issues/2516))
  ([ce83943](https://github.com/loro-dev/lody/commit/ce839431dac24f7407e3d51fec93379ce349b698))
- session file attachments across web, desktop, mobile, CLI, and agents
  ([#2451](https://github.com/loro-dev/lody/issues/2451))
  ([d87c6ad](https://github.com/loro-dev/lody/commit/d87c6ad1b365651c60ee4df978e9f977d5500681))
- support image drag-and-drop anywhere in session interface
  ([#2524](https://github.com/loro-dev/lody/issues/2524))
  ([65b4f83](https://github.com/loro-dev/lody/commit/65b4f8333bbc7c175ba5a9b00419ae7401408357))
- top-level `## Review` findings with multi-location jumps
  ([#2533](https://github.com/loro-dev/lody/issues/2533))
  ([f7aaf01](https://github.com/loro-dev/lody/commit/f7aaf0173aedccb2393bf3703a1feeabb2011861))

### Bug Fixes

- add Code Collab file save shortcut
  ([#2550](https://github.com/loro-dev/lody/issues/2550))
  ([2ccc37a](https://github.com/loro-dev/lody/commit/2ccc37a2181125bf21283ddbe97f64a22036c819))
- add code review helper package
  ([#2509](https://github.com/loro-dev/lody/issues/2509))
  ([3a575ec](https://github.com/loro-dev/lody/commit/3a575ec335ffa543072dab3440d71d0be8c128d8))
- bound Code Collab diff requests
  ([#2565](https://github.com/loro-dev/lody/issues/2565))
  ([6c533c4](https://github.com/loro-dev/lody/commit/6c533c480217542b2842f6250a4a9836b3fe1018))
- **cli:** fall back to legacy NewSessionResponse.models for ACP agents without
  config options ([#2522](https://github.com/loro-dev/lody/issues/2522))
  ([ba36076](https://github.com/loro-dev/lody/commit/ba36076d25c3267fad95fc9eb2f45c4d3e12273b))
- **cli:** guard session diff stats writers
  ([#2515](https://github.com/loro-dev/lody/issues/2515))
  ([efe4b46](https://github.com/loro-dev/lody/commit/efe4b4630f059bb9bdba618ec90f36f8eda8f200))
- **cli:** retry session image downloads before prompt
  ([#2525](https://github.com/loro-dev/lody/issues/2525))
  ([99231e3](https://github.com/loro-dev/lody/commit/99231e33e2bb854770f30ec3ff684c629901adf2))
- **cli:** skip completion notification when user manually stops a turn
  ([#2539](https://github.com/loro-dev/lody/issues/2539))
  ([ceac0b8](https://github.com/loro-dev/lody/commit/ceac0b8954ab4e56c962f98ec01586945b03d2fe))
- Code Collab v2 turn diffs and file diff cache
  ([#2546](https://github.com/loro-dev/lody/issues/2546))
  ([b9015f5](https://github.com/loro-dev/lody/commit/b9015f51dd5ea23930a00b46862308f75d574b8d))
- compute turn-diff line counts with a git-matching line diff
  ([#2602](https://github.com/loro-dev/lody/issues/2602))
  ([f208a30](https://github.com/loro-dev/lody/commit/f208a3087174adb1f559a70f5ff41ee0cca5eb3d))
- dispatch CLI machine RPC requests concurrently
  ([#2609](https://github.com/loro-dev/lody/issues/2609))
  ([8308955](https://github.com/loro-dev/lody/commit/8308955beaeab868036cdbc6d289e0c56df376dc))
- filter unsupported `agent` ACP config option
  ([#2623](https://github.com/loro-dev/lody/issues/2623))
  ([941de42](https://github.com/loro-dev/lody/commit/941de42ab8346875e52c5ca77ca6f160eaff1526))
- isolate ACP npx npm cache
  ([#2526](https://github.com/loro-dev/lody/issues/2526))
  ([ddca1af](https://github.com/loro-dev/lody/commit/ddca1af048d02421780804704ad7a0321fc377fd))
- Isolate Code Collab shared-state renders
  ([#2571](https://github.com/loro-dev/lody/issues/2571))
  ([33c0cb3](https://github.com/loro-dev/lody/commit/33c0cb381a6d82e4420f7dc47ccf263cb13dbd2d))
- Isolate presence streams
  ([#2562](https://github.com/loro-dev/lody/issues/2562))
  ([9809cc1](https://github.com/loro-dev/lody/commit/9809cc19496e55b5eb44e9e5b184bc5fadd84446))
- Preserve assistant entry ownership for ACP updates
  ([#2561](https://github.com/loro-dev/lody/issues/2561))
  ([c3fde0f](https://github.com/loro-dev/lody/commit/c3fde0f6e2ae1e45a1c858fa0b3626169c4c239e))
- remove Lody-injected Full Access mode
  ([#2598](https://github.com/loro-dev/lody/issues/2598))
  ([a6b0cd1](https://github.com/loro-dev/lody/commit/a6b0cd1923339f7ad967b8a46abe0813949175e8))
- restore code collab lazy file indexing
  ([#2557](https://github.com/loro-dev/lody/issues/2557))
  ([371907f](https://github.com/loro-dev/lody/commit/371907fffef40bbe7683d62f822aa834cb421876))
- reuse parent workdir for chat child tabs
  ([#2555](https://github.com/loro-dev/lody/issues/2555))
  ([4b20e64](https://github.com/loro-dev/lody/commit/4b20e64b37f9c93e7e9d783675b5e4d84754c4c3))
- session attachment ACP flow
  ([#2588](https://github.com/loro-dev/lody/issues/2588))
  ([4118b18](https://github.com/loro-dev/lody/commit/4118b18ecc4e45af295cd50128dcba751623ea60))
- store code collab file index in flock
  ([#2618](https://github.com/loro-dev/lody/issues/2618))
  ([b3b7951](https://github.com/loro-dev/lody/commit/b3b79517c90ffb3241db0c0cdd3865254aacde39))
- sync Code Collab turn diff snapshots
  ([#2511](https://github.com/loro-dev/lody/issues/2511))
  ([670b941](https://github.com/loro-dev/lody/commit/670b94161b79156f2154240052a152f543dfc5de))
- wrap session file upload streams for R2
  ([#2585](https://github.com/loro-dev/lody/issues/2585))
  ([4697045](https://github.com/loro-dev/lody/commit/46970453afd32b79695b737a7807e46393f0de22))

### Documentation

- **cli:** document GitHub auth shortcut
  ([#2517](https://github.com/loro-dev/lody/issues/2517))
  ([2e4a485](https://github.com/loro-dev/lody/commit/2e4a4859bc6287c0171b2d5eae84a882b31f376a))
- **cli:** make `lody review` self-explanatory to AI agents
  ([#2531](https://github.com/loro-dev/lody/issues/2531))
  ([dafaaa8](https://github.com/loro-dev/lody/commit/dafaaa8fb8339ec14059da67ab7cc5c963df2de9))

## [0.57.1-next.30](https://github.com/loro-dev/lody/compare/lody-cli-v0.57.1-next.29...lody-cli-v0.57.1-next.30) (2026-06-24)

### Features

- expand skill mentions in prompts
  ([#2608](https://github.com/loro-dev/lody/issues/2608))
  ([6c4a061](https://github.com/loro-dev/lody/commit/6c4a061c9d80a783ea8e1c5bb9c34c79baab952e))

### Bug Fixes

- dispatch CLI machine RPC requests concurrently
  ([#2609](https://github.com/loro-dev/lody/issues/2609))
  ([8308955](https://github.com/loro-dev/lody/commit/8308955beaeab868036cdbc6d289e0c56df376dc))
- store code collab file index in flock
  ([#2618](https://github.com/loro-dev/lody/issues/2618))
  ([b3b7951](https://github.com/loro-dev/lody/commit/b3b79517c90ffb3241db0c0cdd3865254aacde39))

## [0.62.0](https://github.com/loro-dev/lody/compare/lody-cli-v0.61.0...lody-cli-v0.62.0) (2026-06-15)

### Features

- add daily auth activity rollup
  ([#2491](https://github.com/loro-dev/lody/issues/2491))
  ([6347014](https://github.com/loro-dev/lody/commit/6347014037091a6f70c53d1eb675dede191331e8))

### Bug Fixes

- auth
  ([55fe36d](https://github.com/loro-dev/lody/commit/55fe36d55b0637524d967f7fb58147c82fb90bbd))
- **cli:** auto re-bootstrap stale CLI credentials after Electron login
  ([#2498](https://github.com/loro-dev/lody/issues/2498))
  ([4fe9325](https://github.com/loro-dev/lody/commit/4fe932592b3f2e41b6646f8305e2c7e55b8712a1))

## [0.61.0](https://github.com/loro-dev/lody/compare/lody-cli-v0.60.1...lody-cli-v0.61.0) (2026-06-15)

### Features

- **cli:** nudge the agent toward Lody MCP tools in the turn prompt
  ([#2489](https://github.com/loro-dev/lody/issues/2489))
  ([2c33397](https://github.com/loro-dev/lody/commit/2c33397201a71a335e63cdbb5fd5ba668dbed08a))

## [0.60.1](https://github.com/loro-dev/lody/compare/lody-cli-v0.60.0...lody-cli-v0.60.1) (2026-06-14)

### Bug Fixes

- upgrade node-pty for Windows CI
  ([#2484](https://github.com/loro-dev/lody/issues/2484))
  ([b9a51b7](https://github.com/loro-dev/lody/commit/b9a51b7ca924f6d7648e6f5ad2e64f9ff3708e10))
- upgrade node-pty for Windows CI
  ([#2484](https://github.com/loro-dev/lody/issues/2484))
  ([5bff434](https://github.com/loro-dev/lody/commit/5bff434dced06f2b434e5393952b450d49007172))

## [0.60.0](https://github.com/loro-dev/lody/compare/lody-cli-v0.59.1...lody-cli-v0.60.0) (2026-06-14)

### Features

- add embedded terminal ([#2396](https://github.com/loro-dev/lody/issues/2396))
  ([cff0f68](https://github.com/loro-dev/lody/commit/cff0f68fa58cb96071e763f21f1f80091a8ef271))
- **cli:** add local project worktree create option
  ([#2459](https://github.com/loro-dev/lody/issues/2459))
  ([8d1c8ee](https://github.com/loro-dev/lody/commit/8d1c8ee05231a63e85f364d7b4a53735cf907ac5))
- **cli:** record child-session turn diffs via parent Code Collab host
  ([#2454](https://github.com/loro-dev/lody/issues/2454))
  ([1139421](https://github.com/loro-dev/lody/commit/11394216c15966f06cc00c2268c224747b717d2c))
- **cli:** stop writing heartbeat timestamps to meta, rely on ephemeral presence
  ([#2449](https://github.com/loro-dev/lody/issues/2449))
  ([631afe6](https://github.com/loro-dev/lody/commit/631afe6ac2c29558971117694a8834f6d1d456e7))
- preview image files in the mobile file browser
  ([#2479](https://github.com/loro-dev/lody/issues/2479))
  ([484cef1](https://github.com/loro-dev/lody/commit/484cef1462a8918a3ea84a78cbcf8a11cf68b19a))

### Bug Fixes

- align CLI diffStats with PR compare
  ([#2464](https://github.com/loro-dev/lody/issues/2464))
  ([528bbeb](https://github.com/loro-dev/lody/commit/528bbeb2f6154df63c8252c82a09732510b35731))
- make file index changes authoritative
  ([#2463](https://github.com/loro-dev/lody/issues/2463))
  ([1236e3e](https://github.com/loro-dev/lody/commit/1236e3e8040219dd54fe1f11d06438fe8a268f30))
- package embedded cli node-pty
  ([#2476](https://github.com/loro-dev/lody/issues/2476))
  ([4bba3b3](https://github.com/loro-dev/lody/commit/4bba3b3ff3de0b1636fed717ee0a50b346e1ce1c))
- prevent loro reconnect storm
  ([#2468](https://github.com/loro-dev/lody/issues/2468))
  ([9bf83f1](https://github.com/loro-dev/lody/commit/9bf83f1ebaaa79418125f416d42059af372915c1))
- remove diffStats file list
  ([#2457](https://github.com/loro-dev/lody/issues/2457))
  ([7da0bfa](https://github.com/loro-dev/lody/commit/7da0bfaa259fcc1105591f247b6cdedd43251731))
- speed up code collab turn diff persistence
  ([#2460](https://github.com/loro-dev/lody/issues/2460))
  ([82de68e](https://github.com/loro-dev/lody/commit/82de68e0f97a951162ab0d64b7ff103048dbde4b))

### Documentation

- **context:** add implementation discovery guides
  ([#2458](https://github.com/loro-dev/lody/issues/2458))
  ([0de9fd1](https://github.com/loro-dev/lody/commit/0de9fd144ad21b9bf7fcc8e72be5d4ef892aa343))

## [0.59.1](https://github.com/loro-dev/lody/compare/lody-cli-v0.59.0...lody-cli-v0.59.1) (2026-06-11)

### Chores

- **lody-cli:** Synchronize lody-clients versions

## [0.59.0](https://github.com/loro-dev/lody/compare/lody-cli-v0.58.1...lody-cli-v0.59.0) (2026-06-11)

### Features

- add bug report flow with machine log upload
  ([#2434](https://github.com/loro-dev/lody/issues/2434))
  ([f36714e](https://github.com/loro-dev/lody/commit/f36714ecf3986162ee6a725418fb62f2d6ac38e5))

### Documentation

- **cli:** add AGENTS.md noting ACP adapter source repos
  ([#2422](https://github.com/loro-dev/lody/issues/2422))
  ([8a90160](https://github.com/loro-dev/lody/commit/8a90160b8f6f25df53269e990da2d93fd5c4f184))

## [0.57.1-next.16](https://github.com/loro-dev/lody/compare/lody-cli-v0.57.1-next.15...lody-cli-v0.57.1-next.16) (2026-06-11)

### Documentation

- **cli:** add AGENTS.md noting ACP adapter source repos
  ([#2422](https://github.com/loro-dev/lody/issues/2422))
  ([8a90160](https://github.com/loro-dev/lody/commit/8a90160b8f6f25df53269e990da2d93fd5c4f184))

## [0.57.1-next.15](https://github.com/loro-dev/lody/compare/lody-cli-v0.57.1-next.14...lody-cli-v0.57.1-next.15) (2026-06-11)

### Features

- add bug report flow with machine log upload
  ([#2434](https://github.com/loro-dev/lody/issues/2434))
  ([f36714e](https://github.com/loro-dev/lody/commit/f36714ecf3986162ee6a725418fb62f2d6ac38e5))

## [0.57.1-next.14](https://github.com/loro-dev/lody/compare/lody-cli-v0.57.1-next.13...lody-cli-v0.57.1-next.14) (2026-06-11)

### Features

- support user-defined custom ACP providers
  ([#2400](https://github.com/loro-dev/lody/issues/2400))
  ([07fd724](https://github.com/loro-dev/lody/commit/07fd7246af66c74a3c23c4e234e617455af97240))

### Bug Fixes

- **cli:** capture Claude Code edit evidence from in-progress ACP updates
  ([#2421](https://github.com/loro-dev/lody/issues/2421))
  ([0b82d9a](https://github.com/loro-dev/lody/commit/0b82d9a4a428003c9a50885ad7d9ebfeb1b02f61))

## [0.57.1-next.13](https://github.com/loro-dev/lody/compare/lody-cli-v0.57.1-next.12...lody-cli-v0.57.1-next.13) (2026-06-10)

### Features

- **cli:** fall back to turn-start commit for missing per-turn bases
  ([28cfe67](https://github.com/loro-dev/lody/commit/28cfe675bf9526a61b295bd237c825032caa2c32))
- **cli:** reconstruct edit-tool turn captures verified against disk
  ([af77e03](https://github.com/loro-dev/lody/commit/af77e038d6c4b9e8dcbc41ce69f4b9f199e7a549))
- **code-collab:** publish All Changes text checkpoints in file metadata
  ([2a34475](https://github.com/loro-dev/lody/commit/2a344751fb0647cc059542869cccb17df80e39d2))

### Bug Fixes

- **cli:** persist Code Collab fileDiff for failed turns
  ([7aca1e4](https://github.com/loro-dev/lody/commit/7aca1e4506479af0bc3462b11432cbfd5a4ba123))

## [0.57.1-next.12](https://github.com/loro-dev/lody/compare/lody-cli-v0.57.1-next.11...lody-cli-v0.57.1-next.12) (2026-06-10)

### Features

- **cli:** acp-extension-claude 0.44.0 (AskUserQuestion elicitation) +
  @agentclientprotocol/sdk 0.25.0
  ([#2397](https://github.com/loro-dev/lody/issues/2397))
  ([351ab97](https://github.com/loro-dev/lody/commit/351ab97776836f15be2ff45f1361aad6d9e270c0))
- **cli:** capture turn diffs purely from ACP-visible agent edits
  ([c57dcd1](https://github.com/loro-dev/lody/commit/c57dcd12debac2ede89161703390dfdbdb3f9f7c))

### Bug Fixes

- **test:** align integration tests with ACP-visible edit capture
  ([b93d3d0](https://github.com/loro-dev/lody/commit/b93d3d0cfe1a155d43901cfaa0613634ed25a412))

### Documentation

- design for remote add-local-project directory picker
  ([#2387](https://github.com/loro-dev/lody/issues/2387))
  ([1904c14](https://github.com/loro-dev/lody/commit/1904c14d6f81b00cd5dab6ff146bc6e3a3f18e1d))

## [0.57.1-next.11](https://github.com/loro-dev/lody/compare/lody-cli-v0.57.1-next.10...lody-cli-v0.57.1-next.11) (2026-06-09)

### Bug Fixes

- capture git turn diffs from full branch delta
  ([ffec31b](https://github.com/loro-dev/lody/commit/ffec31bebfb56de3ca6dd3b2f362db62cc17f00b))
- **cli:** scope code collab turn history diffs
  ([fdb9509](https://github.com/loro-dev/lody/commit/fdb95091719a352f959230c2ca9ebfc6a9ad94f7))
- **code-collab:** stabilize scenario disk change tests
  ([669d9c9](https://github.com/loro-dev/lody/commit/669d9c94e395b4d75f133e4beebb868a85b196d6))
- preserve code collab text frontiers
  ([acc08e7](https://github.com/loro-dev/lody/commit/acc08e7829a08bf2a95d9641f1f8387d2cbca552))
- recover closed ACP sessions
  ([#2391](https://github.com/loro-dev/lody/issues/2391))
  ([34fab79](https://github.com/loro-dev/lody/commit/34fab79213ecd15d9223d8de0df02981929added))
- stabilize code collab diff tracking
  ([ce68961](https://github.com/loro-dev/lody/commit/ce689612bdffec73b590e29c92af2ba056af4a9d))
- wait for permission history before live activity
  ([#2382](https://github.com/loro-dev/lody/issues/2382))
  ([c88bf42](https://github.com/loro-dev/lody/commit/c88bf427c8335dda0b259bcef90b97f92ecbb4c8))

## [0.57.1-next.10](https://github.com/loro-dev/lody/compare/lody-cli-v0.57.1-next.9...lody-cli-v0.57.1-next.10) (2026-06-08)

### Chores

- **lody-cli:** Synchronize lody-clients versions

## [0.57.1-next.9](https://github.com/loro-dev/lody/compare/lody-cli-v0.57.1-next.8...lody-cli-v0.57.1-next.9) (2026-06-07)

### Features

- add project file browsing for GitHub and local projects
  ([#2357](https://github.com/loro-dev/lody/issues/2357))
  ([a0a571c](https://github.com/loro-dev/lody/commit/a0a571c497124f2bde34da54079771f93b416a76))
- split worktree script history by command
  ([8b6270f](https://github.com/loro-dev/lody/commit/8b6270f15c5f99646563c1e1c25f56d774ee35d1))

### Bug Fixes

- infer worktree scripts from content
  ([7ad0007](https://github.com/loro-dev/lody/commit/7ad000728fccea1e5d510d0d8dc5a92cd3095f4a))
- preserve shared worktree setup history
  ([bda82bb](https://github.com/loro-dev/lody/commit/bda82bb5fe384b347385dd3c1165b73e69a8c672))
- satisfy lint and safe-area tests
  ([00e84f8](https://github.com/loro-dev/lody/commit/00e84f89c06e1f3906a736d0e81116b2d0b2b1e7))
- show worktree command in nested terminal
  ([08f09a7](https://github.com/loro-dev/lody/commit/08f09a78b9705e142576d03e31456db59f1308af))
- show worktree script command
  ([b832656](https://github.com/loro-dev/lody/commit/b83265625c2516fb3df1ffc81ee47a446ff7645a))

### Refactors

- dedupe live activity permission + convex url helpers into shared
  ([1af2140](https://github.com/loro-dev/lody/commit/1af2140ec1abf48ff10e6b0e3c3ca0346ed40390))
- reduce worktree config duplication
  ([c6e5596](https://github.com/loro-dev/lody/commit/c6e5596a0127b9d4437340a7e8aedaa288e1c247))

## [0.57.1-next.8](https://github.com/loro-dev/lody/compare/lody-cli-v0.57.1-next.7...lody-cli-v0.57.1-next.8) (2026-06-06)

### Bug Fixes

- publish loro-crdt as CLI runtime dependency
  ([#2363](https://github.com/loro-dev/lody/issues/2363))
  ([8e81146](https://github.com/loro-dev/lody/commit/8e81146ed3e80350a686eaec611c6a475e20da8c))

## [0.57.1-next.7](https://github.com/loro-dev/lody/compare/lody-cli-v0.57.1-next.6...lody-cli-v0.57.1-next.7) (2026-06-06)

### Bug Fixes

- **cli:** avoid bundled ESM require hook crashes
  ([#2361](https://github.com/loro-dev/lody/issues/2361))
  ([daefe7e](https://github.com/loro-dev/lody/commit/daefe7ee4abb62ae3a341059ade42350c60c03f5))

## [0.57.1-next.6](https://github.com/loro-dev/lody/compare/lody-cli-v0.57.1-next.5...lody-cli-v0.57.1-next.6) (2026-06-06)

### Bug Fixes

- repair Code Collab turn diffs & All Changes
  ([#2337](https://github.com/loro-dev/lody/issues/2337))
  ([a2e84a4](https://github.com/loro-dev/lody/commit/a2e84a4252611e3412cc94ac07ce493a92e271ee))
- retry transient CLI auth validation failures
  ([#2358](https://github.com/loro-dev/lody/issues/2358))
  ([24bfaf7](https://github.com/loro-dev/lody/commit/24bfaf79e7b9c02f0e0b9b0de55ccbf1cdda8b88))

## [0.57.1-next.5](https://github.com/loro-dev/lody/compare/lody-cli-v0.57.1-next.4...lody-cli-v0.57.1-next.5) (2026-06-04)

### Features

- add kimi code registry agent
  ([#2343](https://github.com/loro-dev/lody/issues/2343))
  ([a7e6323](https://github.com/loro-dev/lody/commit/a7e63236a36cda780d2fcf887f5939537226acc1))

## [0.57.1-next.4](https://github.com/loro-dev/lody/compare/lody-cli-v0.57.1-next.3...lody-cli-v0.57.1-next.4) (2026-06-02)

### Bug Fixes

- **cli:** bundle code collab runtime for npm package
  ([7a550ae](https://github.com/loro-dev/lody/commit/7a550ae62d71c98d7376d131a6f22c56a9ea54cc))

## [0.57.1-next.3](https://github.com/loro-dev/lody/compare/lody-cli-v0.57.1-next.2...lody-cli-v0.57.1-next.3) (2026-06-02)

### Bug Fixes

- remove flaky code collab cli e2e
  ([005f01d](https://github.com/loro-dev/lody/commit/005f01d0cd08a0545553b1f669d21a58337ed955))

## [0.57.1-next.2](https://github.com/loro-dev/lody/compare/lody-cli-v0.57.1-next.1...lody-cli-v0.57.1-next.2) (2026-06-02)

### Bug Fixes

- lazy load code collab typescript lsp
  ([6a040ce](https://github.com/loro-dev/lody/commit/6a040ce6ea544e8d3c9c74d422823bb2264d3f31))

## [0.57.1-next.1](https://github.com/loro-dev/lody/compare/lody-cli-v0.57.1-next...lody-cli-v0.57.1-next.1) (2026-06-02)

### Bug Fixes

- **cli:** configure npm auth for release publish
  ([4355717](https://github.com/loro-dev/lody/commit/43557172cd0421c49b39c56098e1221c8e9f0dc0))

## [0.57.1-next](https://github.com/loro-dev/lody/compare/lody-cli-v0.57.0...lody-cli-v0.57.1-next) (2026-06-02)

### Features

- **code-collab:** integrate live files and changes
  ([#2085](https://github.com/loro-dev/lody/issues/2085))
  ([1179dd5](https://github.com/loro-dev/lody/commit/1179dd5db4dc97d4edac6c7dc25f650be95e3b44))

## [0.57.3](https://github.com/loro-dev/lody/compare/lody-cli-v0.57.2...lody-cli-v0.57.3) (2026-06-03)

### Chores

- **lody-cli:** Synchronize lody-clients versions

## [0.57.2](https://github.com/loro-dev/lody/compare/lody-cli-v0.57.1...lody-cli-v0.57.2) (2026-06-03)

### Chores

- **lody-cli:** Synchronize lody-clients versions

## [0.57.1](https://github.com/loro-dev/lody/compare/lody-cli-v0.57.0...lody-cli-v0.57.1) (2026-06-03)

### Bug Fixes

- release trigger
  ([3a9bc2b](https://github.com/loro-dev/lody/commit/3a9bc2b9757e5e0613a112c12fd817ad1665bf43))

## [0.57.0](https://github.com/loro-dev/lody/compare/lody-cli-v0.56.0...lody-cli-v0.57.0) (2026-06-02)

### Bug Fixes

- **cli:** avoid event loop stalls in session startup
  ([#2285](https://github.com/loro-dev/lody/issues/2285))
  ([84a5734](https://github.com/loro-dev/lody/commit/84a57343965a02929f5eb57ffdba5970a892c78f))

## [0.56.0](https://github.com/loro-dev/lody/compare/lody-cli-v0.55.2...lody-cli-v0.56.0) (2026-06-01)

### Features

- **acp:** support binary-distribution registry agents
  ([#2274](https://github.com/loro-dev/lody/issues/2274))
  ([3d11d91](https://github.com/loro-dev/lody/commit/3d11d9177a9a06d0bcdcdd16c2748398d7dcb87e))
- **analytics:** PostHog instrumentation foundation + all P0 events
  ([#2261](https://github.com/loro-dev/lody/issues/2261))
  ([73bd935](https://github.com/loro-dev/lody/commit/73bd935b783cc7b66c537d3f99d0c7faf5676122))
- MiniMax preset + provider brand icons + human-readable model names
  ([#2277](https://github.com/loro-dev/lody/issues/2277))
  ([000fe88](https://github.com/loro-dev/lody/commit/000fe8835f126f5a87d5dd065b697987d894e689))

### Bug Fixes

- **acp-history-sync:** add conflict recovery requirements & plan
  ([#2276](https://github.com/loro-dev/lody/issues/2276))
  ([117120a](https://github.com/loro-dev/lody/commit/117120a18bd107449293419ab050b48ed44afc37))
- **cli:** make codex/claude ACP npx launch resilient to broken installs
  ([#2270](https://github.com/loro-dev/lody/issues/2270))
  ([1a7c604](https://github.com/loro-dev/lody/commit/1a7c6044123703db144a9427afd265d774112bca))
- convex bug
  ([a89fc0c](https://github.com/loro-dev/lody/commit/a89fc0c3e527f2703dfe3b99c885f52f6852e2de))
- hide branches for non-git local projects
  ([#2280](https://github.com/loro-dev/lody/issues/2280))
  ([9bcba74](https://github.com/loro-dev/lody/commit/9bcba74cc36e61526cf085308eb1ce6bcfd27394))
- prevent transient network failures from permanently dropping user messages
  ([#2258](https://github.com/loro-dev/lody/issues/2258))
  ([5d9916a](https://github.com/loro-dev/lody/commit/5d9916aa76943cf4ec7b23e77df20774483b0c5c))

## [0.55.2](https://github.com/loro-dev/lody/compare/lody-cli-v0.55.1...lody-cli-v0.55.2) (2026-05-29)

### Bug Fixes

- inject login-shell PATH when spawning ACP agents
  ([#2243](https://github.com/loro-dev/lody/issues/2243))
  ([41f6cde](https://github.com/loro-dev/lody/commit/41f6cdeee3bd2568bf61862d103a219abb2be439))

## [0.55.1](https://github.com/loro-dev/lody/compare/lody-cli-v0.55.0...lody-cli-v0.55.1) (2026-05-28)

### Bug Fixes

- update opus 4.8
  ([4bcddda](https://github.com/loro-dev/lody/commit/4bcdddab2d57c0f272cdff8259b2932a85f858ab))
- update opus 4.8
  ([89d636d](https://github.com/loro-dev/lody/commit/89d636da43fd18a146241af91881c639b7e5bf88))

## [0.55.0](https://github.com/loro-dev/lody/compare/lody-cli-v0.54.1...lody-cli-v0.55.0) (2026-05-28)

### Chores

- **lody-cli:** Synchronize lody-cli-electron versions

## [0.54.1](https://github.com/loro-dev/lody/compare/lody-cli-v0.54.0...lody-cli-v0.54.1) (2026-05-28)

### Chores

- **lody-cli:** Synchronize lody-cli-electron versions

## [0.54.0](https://github.com/loro-dev/lody/compare/lody-cli-v0.53.0...lody-cli-v0.54.0) (2026-05-26)

### Features

- release 2026-0527
  ([382cac2](https://github.com/loro-dev/lody/commit/382cac215c58a1e14178f8a0f80a35cfc90c5096))

### Bug Fixes

- roll up child tab session activity
  ([#2210](https://github.com/loro-dev/lody/issues/2210))
  ([de91e50](https://github.com/loro-dev/lody/commit/de91e50048512d66cfcbe98e96fa25f45ce9a0a2))

## [0.53.0](https://github.com/loro-dev/lody/compare/lody-cli-v0.52.3...lody-cli-v0.53.0) (2026-05-20)

### Features

- release 2026-0520
  ([82a9e79](https://github.com/loro-dev/lody/commit/82a9e7937111336073d703387f5f37b5114fd56c))
- Support ACP Plan Mode flow
  ([#2147](https://github.com/loro-dev/lody/issues/2147))
  ([ac80eeb](https://github.com/loro-dev/lody/commit/ac80eebd34519fa0330f17dfb402379f65b93a80))

### Bug Fixes

- align history ACP launch with sessions
  ([#2161](https://github.com/loro-dev/lody/issues/2161))
  ([5ab4b2a](https://github.com/loro-dev/lody/commit/5ab4b2a80ce66581a75ed4dce5140d9c02d21f9e))
- **cli:** support gh shim on Windows
  ([#2187](https://github.com/loro-dev/lody/issues/2187))
  ([f6a612d](https://github.com/loro-dev/lody/commit/f6a612d48357db9834a21b2e9822b6f510e197bb))

## [0.52.3](https://github.com/loro-dev/lody/compare/lody-cli-v0.52.2...lody-cli-v0.52.3) (2026-05-17)

### Bug Fixes

- make ACP history imports idempotent
  ([#2155](https://github.com/loro-dev/lody/issues/2155))
  ([4d351a2](https://github.com/loro-dev/lody/commit/4d351a231de204c332be668b681f7f87c535580f))
- remove web local health probe
  ([#2152](https://github.com/loro-dev/lody/issues/2152))
  ([009c017](https://github.com/loro-dev/lody/commit/009c0171c6a54c1b99eb7c3262591042b673934c))

## [0.52.2](https://github.com/loro-dev/lody/compare/lody-cli-v0.52.1...lody-cli-v0.52.2) (2026-05-17)

### Bug Fixes

- claude idle ([#2142](https://github.com/loro-dev/lody/issues/2142))
  ([69962d0](https://github.com/loro-dev/lody/commit/69962d02d080b992812f6160977b71b6e1321b65))
- debug/claude acp prompt diagnostics
  ([#2139](https://github.com/loro-dev/lody/issues/2139))
  ([5a21455](https://github.com/loro-dev/lody/commit/5a21455d3e207070050772bc0fba06c88dbc8934))

## [0.52.1](https://github.com/loro-dev/lody/compare/lody-cli-v0.52.0...lody-cli-v0.52.1) (2026-05-16)

### Bug Fixes

- add cli hang diagnostics
  ([#2135](https://github.com/loro-dev/lody/issues/2135))
  ([01575ec](https://github.com/loro-dev/lody/commit/01575ec656057c5b86e11b0d5b10290aa94a2318))

## [0.52.0](https://github.com/loro-dev/lody/compare/lody-cli-v0.51.0...lody-cli-v0.52.0) (2026-05-16)

### Features

- upgrade acp & trigger
  ([409fbe1](https://github.com/loro-dev/lody/commit/409fbe188d3739b6adb271749d8098d18489f6ab))

## [0.51.0](https://github.com/loro-dev/lody/compare/lody-cli-v0.50.2...lody-cli-v0.51.0) (2026-05-15)

### Features

- claude sync
  ([428bb64](https://github.com/loro-dev/lody/commit/428bb6452c2330f0910049c7c95ffbb1397a88ba))
- Codex/Claude Code local project history sync
  ([#2119](https://github.com/loro-dev/lody/issues/2119))
  ([428bb64](https://github.com/loro-dev/lody/commit/428bb6452c2330f0910049c7c95ffbb1397a88ba))

## [0.50.2](https://github.com/loro-dev/lody/compare/lody-cli-v0.50.1...lody-cli-v0.50.2) (2026-05-13)

### Bug Fixes

- codex version
  ([f211354](https://github.com/loro-dev/lody/commit/f211354f5311a2f3007304aa5befeb31517c549e))
- recover onboarding provider auth sync
  ([#2105](https://github.com/loro-dev/lody/issues/2105))
  ([c8552b4](https://github.com/loro-dev/lody/commit/c8552b4e135e534192a1d98e99083cae99c5bd77))
- suppress completion notifications for active goals
  ([#2110](https://github.com/loro-dev/lody/issues/2110))
  ([bd63a72](https://github.com/loro-dev/lody/commit/bd63a72a54ea73c6fdf57ce8817ec2ed91db5539))

## [0.50.1](https://github.com/loro-dev/lody/compare/lody-cli-v0.50.0...lody-cli-v0.50.1) (2026-05-09)

### Bug Fixes

- **chat-landing:** allow teammates to use shared local projects
  ([#2078](https://github.com/loro-dev/lody/issues/2078))
  ([a9c0977](https://github.com/loro-dev/lody/commit/a9c097711a99bee6051e14665ae52c1a9a6db5b9))
- **onboarding:** re-bootstrap CLI when desktop session userId mismatches
  ([#2083](https://github.com/loro-dev/lody/issues/2083))
  ([d81cb60](https://github.com/loro-dev/lody/commit/d81cb6015edfae78582b9f25fcb16f9564c4ede6))

## [0.50.0](https://github.com/loro-dev/lody/compare/lody-cli-v0.49.1...lody-cli-v0.50.0) (2026-05-09)

### Features

- release 2026-0509
  ([7ba810d](https://github.com/loro-dev/lody/commit/7ba810dad2f44325915d36650076bc30d017f2bf))

### Bug Fixes

- **components:** disable text selection in left sidebar
  ([#2065](https://github.com/loro-dev/lody/issues/2065))
  ([c2a5e63](https://github.com/loro-dev/lody/commit/c2a5e63e1277016ffd9cb66f4f07a5e826c7b7ca))
- preserve synced machine names on registration
  ([#2063](https://github.com/loro-dev/lody/issues/2063))
  ([8f670bd](https://github.com/loro-dev/lody/commit/8f670bd419605191b5cad445cc5f49ac74eb4e19))
- use npx for builtin acp agents
  ([#2060](https://github.com/loro-dev/lody/issues/2060))
  ([43d07e4](https://github.com/loro-dev/lody/commit/43d07e47863a2e8bbd1b4c06d9a07036ab7db5a1))

### Documentation

- add local project worktree design
  ([#2070](https://github.com/loro-dev/lody/issues/2070))
  ([793915e](https://github.com/loro-dev/lody/commit/793915eae089a6d7798f59856c42ec582dfc4885))

## [0.49.1](https://github.com/loro-dev/lody/compare/lody-cli-v0.49.0...lody-cli-v0.49.1) (2026-05-07)

### Bug Fixes

- Remove preview tunnel port owner check
  ([06c30b9](https://github.com/loro-dev/lody/commit/06c30b96798dbce24486a0b7951ed692e75eb3f0))

## [0.49.0](https://github.com/loro-dev/lody/compare/lody-cli-v0.48.0...lody-cli-v0.49.0) (2026-05-07)

### Features

- add visual annotation inspector design
  ([#2002](https://github.com/loro-dev/lody/issues/2002))
  ([e7789c6](https://github.com/loro-dev/lody/commit/e7789c6728f1eb62e7b95e3cfa85870961fa8ceb))
- connect remote preview annotations
  ([#2017](https://github.com/loro-dev/lody/issues/2017))
  ([5a22c3a](https://github.com/loro-dev/lody/commit/5a22c3ad5eb6b2cb786add8e809c98fee2567b11))
- goal pin redesign ([#2035](https://github.com/loro-dev/lody/issues/2035))
  ([22bf4a1](https://github.com/loro-dev/lody/commit/22bf4a196db31c64b5d665a3ffb025861dd5d5a1))
- integrate codex goal messages
  ([#2000](https://github.com/loro-dev/lody/issues/2000))
  ([5acbc68](https://github.com/loro-dev/lody/commit/5acbc68734bb7141af82e26972a882094a699427))
- release 260507
  ([3709913](https://github.com/loro-dev/lody/commit/370991344148b47d99d180142c2f95b85f679883))
- support ACP ask user questions
  ([#2010](https://github.com/loro-dev/lody/issues/2010))
  ([00d6d78](https://github.com/loro-dev/lody/commit/00d6d7805973bae812d41379e5a4a4f7ef386bed))
- support personal github operation tokens
  ([#1960](https://github.com/loro-dev/lody/issues/1960))
  ([0c292f3](https://github.com/loro-dev/lody/commit/0c292f321be0f5fc7a94f3356f7368f38ab8b2c4))

### Bug Fixes

- acp version
  ([106061c](https://github.com/loro-dev/lody/commit/106061ce31bb17fe9b052627a4e5ec85ec3825e6))
- claude
  ([2ddd908](https://github.com/loro-dev/lody/commit/2ddd9084df99543c6de091d151ba51d5033f13bd))
- **cli:** scrub inherited Anthropic env when Claude has explicit auth
  ([#2043](https://github.com/loro-dev/lody/issues/2043))
  ([636b542](https://github.com/loro-dev/lody/commit/636b542d699e7724d309e698474de957a99c2d24))
- close preview tunnels during session cleanup
  ([#1997](https://github.com/loro-dev/lody/issues/1997))
  ([dacc7b9](https://github.com/loro-dev/lody/commit/dacc7b93ed97e23e6863047e978808d52dd90786))
- handle preview annotation capture reliably
  ([#2023](https://github.com/loro-dev/lody/issues/2023))
  ([c03e2a9](https://github.com/loro-dev/lody/commit/c03e2a93732902542437d3d9f06316bd17bd164d))
- handle preview annotation origin races
  ([#2028](https://github.com/loro-dev/lody/issues/2028))
  ([636fb62](https://github.com/loro-dev/lody/commit/636fb625f1b3c0600f2f2a2076d5287d840a9fb4))
- keep preview token auth in embedded frames
  ([#2029](https://github.com/loro-dev/lody/issues/2029))
  ([5a85da8](https://github.com/loro-dev/lody/commit/5a85da81d149349908860433124c09ef443ab831))
- make preview annotations install reliably
  ([#2026](https://github.com/loro-dev/lody/issues/2026))
  ([0d38d6e](https://github.com/loro-dev/lody/commit/0d38d6ecbe2aa7e881e1be3a0192656a04a96dfd))
- skip Loro cid ACP config option
  ([#2011](https://github.com/loro-dev/lody/issues/2011))
  ([2fc4c8b](https://github.com/loro-dev/lody/commit/2fc4c8bd2c60fdebd5acbf9c19943c87122214d8))
- strip undefined history values before mirror writes
  ([#2038](https://github.com/loro-dev/lody/issues/2038))
  ([6147676](https://github.com/loro-dev/lody/commit/614767664a8ee2ad5851a1c8bf9f59ad7cca190d))
- support codex goal continuation updates
  ([#2006](https://github.com/loro-dev/lody/issues/2006))
  ([1b991b2](https://github.com/loro-dev/lody/commit/1b991b2298bc04f8f3bf3453d20273c46d52bd03))
- surface preview tunnel create response details
  ([#2005](https://github.com/loro-dev/lody/issues/2005))
  ([d3baed9](https://github.com/loro-dev/lody/commit/d3baed9416233787f2fbac77e260c72a93dbd480))
- use ask question titles in notifications
  ([#2030](https://github.com/loro-dev/lody/issues/2030))
  ([f595d86](https://github.com/loro-dev/lody/commit/f595d86fd33ede5b5a300baddf4ddaa6ff077716))

### Performance

- **cli:** prefer offline npx cache for ACP agent launching
  ([#1981](https://github.com/loro-dev/lody/issues/1981))
  ([77d9739](https://github.com/loro-dev/lody/commit/77d973977066a0b453dcdceae24385771aa389f1))

## [0.48.0](https://github.com/loro-dev/lody/compare/lody-cli-v0.47.1...lody-cli-v0.48.0) (2026-04-28)

### Features

- probe streams-api health before falling back to proxy
  ([#1943](https://github.com/loro-dev/lody/issues/1943))
  ([2a90e41](https://github.com/loro-dev/lody/commit/2a90e41a372d14cbfd26e9e6a9577208330dd970))

### Bug Fixes

- **cli:** recover session dispatch after stopped turns
  ([#1919](https://github.com/loro-dev/lody/issues/1919))
  ([85bf328](https://github.com/loro-dev/lody/commit/85bf3284017cfa3f8d62ce8e7cdf118edd5e61eb))
- gpt-5.5 price
  ([0ef9630](https://github.com/loro-dev/lody/commit/0ef96303782d5efc331dfa4efa82b4e2d9da7c5f))
- mobile white screen
  ([59590ec](https://github.com/loro-dev/lody/commit/59590ec4dbdcccbb573656d223a25d97fe00a35e))
- pass provider env to acp capability refresh
  ([#1956](https://github.com/loro-dev/lody/issues/1956))
  ([dcc21bf](https://github.com/loro-dev/lody/commit/dcc21bf52e9e1f96f8141c9df87c36271d571b95))

## [0.47.1](https://github.com/loro-dev/lody/compare/lody-cli-v0.47.0...lody-cli-v0.47.1) (2026-04-27)

### Bug Fixes

- codex use computer error
  ([c08cc06](https://github.com/loro-dev/lody/commit/c08cc06b76922891512874a8303e6c9b046eda64))
- use computer error
  ([6a47eba](https://github.com/loro-dev/lody/commit/6a47eba7df39dfcbc8fde1b517468b1727d9def9))

## [0.47.0](https://github.com/loro-dev/lody/compare/lody-cli-v0.46.0...lody-cli-v0.47.0) (2026-04-27)

### Features

- sync live presence through ephemeral store
  ([#1910](https://github.com/loro-dev/lody/issues/1910))
  ([f54b814](https://github.com/loro-dev/lody/commit/f54b8146a90c48c3c114ad27c4a758297872e457))

### Bug Fixes

- **cli:** harden ACP agent streams
  ([#1914](https://github.com/loro-dev/lody/issues/1914))
  ([8b66c1f](https://github.com/loro-dev/lody/commit/8b66c1fbea9ae0eab49bbf757ba96a620b9b608b))
- probe ACP capabilities from current directory
  ([#1925](https://github.com/loro-dev/lody/issues/1925))
  ([e6677ce](https://github.com/loro-dev/lody/commit/e6677cea11ed438113ae4e0807d72d1dc456fbe9))

## [0.46.0](https://github.com/loro-dev/lody/compare/lody-cli-v0.45.1...lody-cli-v0.46.0) (2026-04-24)

### Features

- **shared:** cache Loro Streams JWT token in localStorage
  ([#1898](https://github.com/loro-dev/lody/issues/1898))
  ([d543b7c](https://github.com/loro-dev/lody/commit/d543b7ca06c62a1460bdc66c84f6b347c828e09c))

### Bug Fixes

- **cli:** clear processingUserMsgId after dispatch recovery
  ([#1899](https://github.com/loro-dev/lody/issues/1899))
  ([9f71260](https://github.com/loro-dev/lody/commit/9f71260ba29b36efc51d8bd7e1b71ea88f806ff6))
- Harden memory pressure admission and darwin memory detection
  ([#1895](https://github.com/loro-dev/lody/issues/1895))
  ([e5b0f4b](https://github.com/loro-dev/lody/commit/e5b0f4b0fdd493080ce36fdc7e009536c343a8fc))
- remove dispatchError from session meta
  ([#1891](https://github.com/loro-dev/lody/issues/1891))
  ([f392f20](https://github.com/loro-dev/lody/commit/f392f204e9e5076c26c81a0b57a7cb04930fc30f))
- trigger cli release
  ([f74b69b](https://github.com/loro-dev/lody/commit/f74b69b9be7e700af4eda12b10a2a416c40efa68))

## [0.46.1-next.1](https://github.com/loro-dev/lody/compare/lody-cli-v0.46.0-next.1...lody-cli-v0.46.1-next.1) (2026-04-24)

### Features

- add --heartbeat-log mode to cli start command
  ([#1479](https://github.com/loro-dev/lody/issues/1479))
  ([9f551df](https://github.com/loro-dev/lody/commit/9f551dff18919ece32b1cf820d87ce848d7ef8aa))
- add cli session export command
  ([#1446](https://github.com/loro-dev/lody/issues/1446))
  ([642db51](https://github.com/loro-dev/lody/commit/642db5179d8b16ce2346fbfcba607a59034ca1e1))
- add fast mode config toggle
  ([#1842](https://github.com/loro-dev/lody/issues/1842))
  ([984adf9](https://github.com/loro-dev/lody/commit/984adf95f4c53fe3f971967ab388ca33b6d40483))
- add github list cli command
  ([#1522](https://github.com/loro-dev/lody/issues/1522))
  ([a29d55f](https://github.com/loro-dev/lody/commit/a29d55f51612138ec6ab7b7d7da9319cec5f4314))
- add Lody Full Access mode
  ([#1791](https://github.com/loro-dev/lody/issues/1791))
  ([4c22cd1](https://github.com/loro-dev/lody/commit/4c22cd1ec0e800c46bdfde51ab87cc1da3721590))
- add lodyFullAccess config for auto-approving agent permissions
  ([#1790](https://github.com/loro-dev/lody/issues/1790))
  ([b2aaa5c](https://github.com/loro-dev/lody/commit/b2aaa5caf5d2b30ca3673455efdfbe274aa82ae8))
- add native OneSignal push support for mobile
  ([#1610](https://github.com/loro-dev/lody/issues/1610))
  ([ca7f08b](https://github.com/loro-dev/lody/commit/ca7f08bf0269c0745e3826a8543f070671b88d2b))
- add non-interactive CLI auth
  ([#1770](https://github.com/loro-dev/lody/issues/1770))
  ([e27afa5](https://github.com/loro-dev/lody/commit/e27afa59704708e9deffd58cbbb5a0a00c11b57b))
- add posthog usage telemetry
  ([#1721](https://github.com/loro-dev/lody/issues/1721))
  ([5c016fd](https://github.com/loro-dev/lody/commit/5c016fdaa2f41f0cd3d03ac62a19e29116e644b3))
- add team machine visibility controls
  ([#1806](https://github.com/loro-dev/lody/issues/1806))
  ([35b7674](https://github.com/loro-dev/lody/commit/35b76745ec873b3a979b69a890ca5a4d7d564660))
- auto-populate title generation defaults for builtin agent configs
  ([#1452](https://github.com/loro-dev/lody/issues/1452))
  ([8da128b](https://github.com/loro-dev/lody/commit/8da128bbb3683f2f3704723f470d4862d23057ac))
- **cli:** add daemon mode and extract cli-supervisor package
  ([#1568](https://github.com/loro-dev/lody/issues/1568))
  ([d45af11](https://github.com/loro-dev/lody/commit/d45af11722e57b486d30a1b02829829f98343d20))
- **cli:** add daemon restart subcommand
  ([#1824](https://github.com/loro-dev/lody/issues/1824))
  ([c1e8531](https://github.com/loro-dev/lody/commit/c1e8531d9978a0efef2924a44b0ce6543e249e98))
- **cli:** auto commit and push for PR-linked sessions
  ([#1512](https://github.com/loro-dev/lody/issues/1512))
  ([d8b064f](https://github.com/loro-dev/lody/commit/d8b064fb4df55a54634db68aba3edb403a992c1b))
- **cli:** fail fast when the local daemon is not running
  ([#1832](https://github.com/loro-dev/lody/issues/1832))
  ([1f702e0](https://github.com/loro-dev/lody/commit/1f702e0bcf768fe81c6153d58bfae455d2acffb0))
- **cli:** support ACP loadSession for native session resume
  ([#1541](https://github.com/loro-dev/lody/issues/1541))
  ([efc4042](https://github.com/loro-dev/lody/commit/efc404209def58fea76b5b534c1cdc54e64cc118))
- **cli:** unify session GC with memory pressure eviction
  ([#1565](https://github.com/loro-dev/lody/issues/1565))
  ([6970429](https://github.com/loro-dev/lody/commit/6970429a1c7fc771e5b81f2ecbd63554ab927d0e))
- complete ACP adapter integration for OpenCode and Kimi
  ([#1766](https://github.com/loro-dev/lody/issues/1766))
  ([e459838](https://github.com/loro-dev/lody/commit/e459838b05c932d8c5c4e86d3c0f8723c13d84ef))
- complete Effect session lifecycle phase 1
  ([#1754](https://github.com/loro-dev/lody/issues/1754))
  ([0986c8f](https://github.com/loro-dev/lody/commit/0986c8f8d7e320eb4c9cdd6a8d3f55072c6f4d91))
- complete loro streams migration
  ([#1404](https://github.com/loro-dev/lody/issues/1404))
  ([177bf05](https://github.com/loro-dev/lody/commit/177bf0549126cf7fc8b573be8e08b6254ee9c59c))
- **components:** add session pin for context recall
  ([#1530](https://github.com/loro-dev/lody/issues/1530))
  ([e207266](https://github.com/loro-dev/lody/commit/e2072661783849b1541cac39716771d12767878c))
- diff comment system ([#1679](https://github.com/loro-dev/lody/issues/1679))
  ([e968685](https://github.com/loro-dev/lody/commit/e968685410fc693db8359eb6e35f953508a50e5a))
- enable registry ACP agents (OpenCode, Kimi) on chat landing
  ([#1764](https://github.com/loro-dev/lody/issues/1764))
  ([92dc297](https://github.com/loro-dev/lody/commit/92dc297f94827a23944a0c118cff2312a4ec1007))
- expand posthog instrumentation
  ([#1397](https://github.com/loro-dev/lody/issues/1397))
  ([9a65bff](https://github.com/loro-dev/lody/commit/9a65bff9af96232986c6de523830e8ef5b1be425))
- filter lock file diffs in viewer
  ([#1649](https://github.com/loro-dev/lody/issues/1649))
  ([ebb6927](https://github.com/loro-dev/lody/commit/ebb6927e55b9542833d4ef6c082faa6f4b6615ed))
- multi-tab session ([#1438](https://github.com/loro-dev/lody/issues/1438))
  ([ee7b939](https://github.com/loro-dev/lody/commit/ee7b939ebb3d95ab5a52b7fb717f881de24ab128))
- release 2026-03-20 ([#1421](https://github.com/loro-dev/lody/issues/1421))
  ([0f17bb9](https://github.com/loro-dev/lody/commit/0f17bb934e53be702a5cbf286e30d35052ef8af7))
- release 2026-03-24 ([#1455](https://github.com/loro-dev/lody/issues/1455))
  ([80b6f82](https://github.com/loro-dev/lody/commit/80b6f828fd539b70874acb4cbb5b946f718651df))
- release 260422 ([#1879](https://github.com/loro-dev/lody/issues/1879))
  ([150961f](https://github.com/loro-dev/lody/commit/150961f36329fca28168b2861590d2faed6dae25))
- **shared:** add static title generation defaults for builtin agent configs
  ([#1552](https://github.com/loro-dev/lody/issues/1552))
  ([9abf530](https://github.com/loro-dev/lody/commit/9abf5303051bb78339a7c6f84186ac3f82422435))
- **shared:** cache Loro Streams JWT token in localStorage
  ([#1898](https://github.com/loro-dev/lody/issues/1898))
  ([d543b7c](https://github.com/loro-dev/lody/commit/d543b7ca06c62a1460bdc66c84f6b347c828e09c))
- stream structured session output for create and chat
  ([#1517](https://github.com/loro-dev/lody/issues/1517))
  ([aa009b1](https://github.com/loro-dev/lody/commit/aa009b10b02217715f1f936d6881e60383e81b89))
- support title generation for all ACP agents
  ([#1440](https://github.com/loro-dev/lody/issues/1440))
  ([9211184](https://github.com/loro-dev/lody/commit/92111846a41579d37efd669fd14050ca702657d9))
- unify file/diff viewer tabs into session tab bar
  ([#1470](https://github.com/loro-dev/lody/issues/1470))
  ([adcb217](https://github.com/loro-dev/lody/commit/adcb21797b58bf043a8b91bccf47ac8232ffdcf9))
- upgrade acp
  ([513fcfd](https://github.com/loro-dev/lody/commit/513fcfdabb9f83935c170a704cfa23e545a7f7a5))

### Bug Fixes

- acp unsupport config option
  ([#1426](https://github.com/loro-dev/lody/issues/1426))
  ([96a0695](https://github.com/loro-dev/lody/commit/96a06956950b9dcb17e34fd1fb5065cea49d95ee))
- add backward compatibility fallback for setSessionConfigOption
  ([#1424](https://github.com/loro-dev/lody/issues/1424))
  ([7f45585](https://github.com/loro-dev/lody/commit/7f45585702a07ab98885bf1c98d15820be81fb23))
- allow client start without required cli installs
  ([#1608](https://github.com/loro-dev/lody/issues/1608))
  ([beb184d](https://github.com/loro-dev/lody/commit/beb184d42520b4f080f4d49815642bc7d5e0e440))
- **auth:** show only manual CLI tokens in account settings
  ([#1870](https://github.com/loro-dev/lody/issues/1870))
  ([80bbbe6](https://github.com/loro-dev/lody/commit/80bbbe6d88363e31e52890052b79a29351594929))
- bind manual CLI tokens on first machine use
  ([#1855](https://github.com/loro-dev/lody/issues/1855))
  ([e8767ea](https://github.com/loro-dev/lody/commit/e8767ea902e313a538f3d1492b6d8baf3d2e8de5))
- cli deps
  ([7a44905](https://github.com/loro-dev/lody/commit/7a44905e398ca487f0a9033959f24b1a0b4e9df9))
- cli packaging err
  ([79842ed](https://github.com/loro-dev/lody/commit/79842edeebfcacf7a44bc5207e960fb784a27ba7))
- cli zstd wasm packaging
  ([#1734](https://github.com/loro-dev/lody/issues/1734))
  ([4051e76](https://github.com/loro-dev/lody/commit/4051e76ad3bf1b66da8c52a68bf9e0427d6f06d7))
- **cli:** cap dispatch recovery retries
  ([#1875](https://github.com/loro-dev/lody/issues/1875))
  ([af6d408](https://github.com/loro-dev/lody/commit/af6d40841a1a64a2483a4ba666becf7a9c3018d6))
- **cli:** clear processingUserMsgId after dispatch recovery
  ([#1899](https://github.com/loro-dev/lody/issues/1899))
  ([9f71260](https://github.com/loro-dev/lody/commit/9f71260ba29b36efc51d8bd7e1b71ea88f806ff6))
- **cli:** deduplicate machine ID in Docker by appending random suffix
  ([#1810](https://github.com/loro-dev/lody/issues/1810))
  ([1355081](https://github.com/loro-dev/lody/commit/135508153db2d770cec4d64f29eb44ec7fc8a2ec))
- **cli:** diagnostic logging for stream_not_found room join errors
  ([#1553](https://github.com/loro-dev/lody/issues/1553))
  ([b22b9c0](https://github.com/loro-dev/lody/commit/b22b9c04ee05b5ee32c3139c067bfc50188a1650))
- **cli:** fix process leak and aggregate per-session state
  ([#1539](https://github.com/loro-dev/lody/issues/1539))
  ([dab6e5d](https://github.com/loro-dev/lody/commit/dab6e5d3fd42e4ded60a7eba9824b693ffa8aadf))
- **cli:** fix session dispatch bugs for old and new sessions
  ([#1519](https://github.com/loro-dev/lody/issues/1519))
  ([484e956](https://github.com/loro-dev/lody/commit/484e9560ede663b29119e12199dc72eceb14d15e))
- **cli:** lazily join session rooms instead of eagerly connecting all on
  startup ([#1569](https://github.com/loro-dev/lody/issues/1569))
  ([1cae649](https://github.com/loro-dev/lody/commit/1cae649cf05a19cc289caa8f9d3f68702a1dbb49))
- **cli:** recover Loro metadata stream disconnects
  ([#1828](https://github.com/loro-dev/lody/issues/1828))
  ([0750051](https://github.com/loro-dev/lody/commit/0750051a738328f616f5540badb880ffe363ffca))
- **cli:** reduce ACP idle timeout from 3 hours to 30 minutes
  ([#1515](https://github.com/loro-dev/lody/issues/1515))
  ([b52ea81](https://github.com/loro-dev/lody/commit/b52ea8184de83210a269f6f0984807f7812c63e3))
- **cli:** reduce default info log noise
  ([#1720](https://github.com/loro-dev/lody/issues/1720))
  ([220a7b5](https://github.com/loro-dev/lody/commit/220a7b5da94b9c9bd24546364e0b525abd01f48e))
- **cli:** replace posthog-node with http client
  ([#1465](https://github.com/loro-dev/lody/issues/1465))
  ([01c48e9](https://github.com/loro-dev/lody/commit/01c48e901d848e8b7b2bd96416c904d2dc674d8e))
- **cli:** resolve CLI not responding to web-initiated sessions
  ([#1570](https://github.com/loro-dev/lody/issues/1570))
  ([c2308bb](https://github.com/loro-dev/lody/commit/c2308bb7b9ee42779f68bae60977df70b1b6fe3b))
- **cli:** retry dispatch after missing session history sync
  ([#1864](https://github.com/loro-dev/lody/issues/1864))
  ([252cd25](https://github.com/loro-dev/lody/commit/252cd252dd8217f280012823f0dffc75218b4a44))
- **cli:** reuse non-default worktree branches
  ([#1811](https://github.com/loro-dev/lody/issues/1811))
  ([73ecd16](https://github.com/loro-dev/lody/commit/73ecd168822da22f19f613a7c5e0e29ba2368142))
- **cli:** simplify dispatch history sync recovery
  ([#1882](https://github.com/loro-dev/lody/issues/1882))
  ([5aac7d8](https://github.com/loro-dev/lody/commit/5aac7d8b0f91cfb9f7c28e8f1f8d6c989f2676b6))
- **cli:** skip auto commit after cancelled turn
  ([#1671](https://github.com/loro-dev/lody/issues/1671))
  ([6db2256](https://github.com/loro-dev/lody/commit/6db2256a80750dfae78b19f08b4224de4d0f311b))
- **cli:** stop commit prompts after cancellation
  ([#1877](https://github.com/loro-dev/lody/issues/1877))
  ([61c7a67](https://github.com/loro-dev/lody/commit/61c7a6762a0d1405424203d68d91626ae81c4619))
- **cli:** suppress acp replay during session restore
  ([#1562](https://github.com/loro-dev/lody/issues/1562))
  ([f84e83b](https://github.com/loro-dev/lody/commit/f84e83bbc5cbdddc82259c7832ae8c1b624ff0eb))
- **cli:** translate build prompt instructions
  ([#1753](https://github.com/loro-dev/lody/issues/1753))
  ([f363486](https://github.com/loro-dev/lody/commit/f363486bb48e4a5e96508ced2ac3fd396db2b1a8))
- close acp sessions before process teardown
  ([#1554](https://github.com/loro-dev/lody/issues/1554))
  ([54bfccc](https://github.com/loro-dev/lody/commit/54bfccc0c624dc716b731b9a009c85fd5b5cdfda))
- **components:** prevent PR drawer swipe from opening sidebar
  ([#1876](https://github.com/loro-dev/lody/issues/1876))
  ([da6e9f7](https://github.com/loro-dev/lody/commit/da6e9f73ced4d8372b63c3a7ad7dffd10df2e30f))
- **components:** restore legacy session agent config labels
  ([#1871](https://github.com/loro-dev/lody/issues/1871))
  ([16af363](https://github.com/loro-dev/lody/commit/16af3639596f50cfc7b81b14562851dea0e2e4d9))
- **components:** route session quick actions to active tab
  ([#1518](https://github.com/loro-dev/lody/issues/1518))
  ([214aa97](https://github.com/loro-dev/lody/commit/214aa9762cffb88a22b1cfa2409e0f459e4d6ac6))
- **components:** sync pending invitations on workspace switch and add cancel
  ([#1820](https://github.com/loro-dev/lody/issues/1820))
  ([0905a29](https://github.com/loro-dev/lody/commit/0905a294e2f4a01935ee8a0aa16653d6b3e1318c))
- defer child tab session creation and reuse parent workdir
  ([#1490](https://github.com/loro-dev/lody/issues/1490))
  ([aa475bf](https://github.com/loro-dev/lody/commit/aa475bfc2915bb94cabebed21d53e53109572ef3))
- display specific ACP error reasons in chat failure notices
  ([80b6f82](https://github.com/loro-dev/lody/commit/80b6f828fd539b70874acb4cbb5b946f718651df))
- don't terminate session on transient upstream API errors (500/529)
  ([#1538](https://github.com/loro-dev/lody/issues/1538))
  ([6d12e96](https://github.com/loro-dev/lody/commit/6d12e963af75eeddcc768289775113d5af66036b))
- enable automatic snapshot upload on streams-crdt
  ([#1462](https://github.com/loro-dev/lody/issues/1462))
  ([374157b](https://github.com/loro-dev/lody/commit/374157b1f1c28cdc3f230b6dcc8a3463f0b3de48))
- extract detailed error message from ACP error data.message field
  ([#1448](https://github.com/loro-dev/lody/issues/1448))
  ([680985b](https://github.com/loro-dev/lody/commit/680985b172b5b76399ad3442cb2fd92a57f0561e))
- force official registry for codex acp
  ([#1616](https://github.com/loro-dev/lody/issues/1616))
  ([8d6a57f](https://github.com/loro-dev/lody/commit/8d6a57f4f119b244607938d48238bfeefc54cb82))
- handle empty remote repos in worktree creation
  ([#1441](https://github.com/loro-dev/lody/issues/1441))
  ([99e8805](https://github.com/loro-dev/lody/commit/99e8805f658b38850b546fb7f6e0dcf4d0845f07))
- Harden memory pressure admission and darwin memory detection
  ([#1895](https://github.com/loro-dev/lody/issues/1895))
  ([e5b0f4b](https://github.com/loro-dev/lody/commit/e5b0f4b0fdd493080ce36fdc7e009536c343a8fc))
- keep permission requests on active turn
  ([#1799](https://github.com/loro-dev/lody/issues/1799))
  ([177be84](https://github.com/loro-dev/lody/commit/177be8477958189ad2f041f617683f4de52a2a6a))
- make CLI start shutdown interruptible
  ([#1675](https://github.com/loro-dev/lody/issues/1675))
  ([ae1cc5f](https://github.com/loro-dev/lody/commit/ae1cc5ff6113400ae586865309d4e540948826b4))
- make session heartbeat scoped and nonblocking
  ([#1775](https://github.com/loro-dev/lody/issues/1775))
  ([828e859](https://github.com/loro-dev/lody/commit/828e859fb1d20b97877d8bf00d15a71c326b3f47))
- make session resource limits cgroup-aware to prevent machine lockups
  ([#1622](https://github.com/loro-dev/lody/issues/1622))
  ([3a2933c](https://github.com/loro-dev/lody/commit/3a2933c4c9304dba06078a74a44aa5ceeea13121))
- normalize CLI process resource profiles
  ([#1749](https://github.com/loro-dev/lody/issues/1749))
  ([02f5672](https://github.com/loro-dev/lody/commit/02f56722bccefc8f6e352dfe537e4e927172b496))
- parse Kimi ACP terminal, read, and edit notifications into Loro history
  ([#1776](https://github.com/loro-dev/lody/issues/1776))
  ([8a8cb94](https://github.com/loro-dev/lody/commit/8a8cb94c1066f0854cdc8f0647beda18435ca992))
- persist active session tab in URL
  ([#1625](https://github.com/loro-dev/lody/issues/1625))
  ([474f17e](https://github.com/loro-dev/lody/commit/474f17ee8cc28d8210510b0b4d0012f29a2c0a27))
- preserve image blocks with null metadata
  ([#1712](https://github.com/loro-dev/lody/issues/1712))
  ([f34638d](https://github.com/loro-dev/lody/commit/f34638d70f9a2c590070879e4d49aa8bb7150a4c))
- recover disconnected streams rooms on visibility change
  ([#1474](https://github.com/loro-dev/lody/issues/1474))
  ([e98e4b9](https://github.com/loro-dev/lody/commit/e98e4b93ba87288f42250655b35bc595edcd3154))
- reduce cli log volume and retention
  ([#1628](https://github.com/loro-dev/lody/issues/1628))
  ([2904dcd](https://github.com/loro-dev/lody/commit/2904dcdcf0d9e19ead1f4fb1be47f135acac0aa0))
- refresh GH_TOKEN at turn start instead of turn end
  ([#1613](https://github.com/loro-dev/lody/issues/1613))
  ([423e8b9](https://github.com/loro-dev/lody/commit/423e8b9cf23d4d0eb1aa0d1a6dc719a655af42d1))
- refresh stale acp capabilities
  ([#1744](https://github.com/loro-dev/lody/issues/1744))
  ([00d1573](https://github.com/loro-dev/lody/commit/00d1573785621247f1195b5f4b518ea5035e3d12))
- remove dispatchError from session meta
  ([#1891](https://github.com/loro-dev/lody/issues/1891))
  ([f392f20](https://github.com/loro-dev/lody/commit/f392f204e9e5076c26c81a0b57a7cb04930fc30f))
- repair packaged electron cli startup
  ([#1727](https://github.com/loro-dev/lody/issues/1727))
  ([a8fc91c](https://github.com/loro-dev/lody/commit/a8fc91cfd5f5a39d4d96d5b26a5085729110d902))
- resolve Full Access auto-approve not working for kimi and legacy-mode agents
  ([#1796](https://github.com/loro-dev/lody/issues/1796))
  ([5fadb5d](https://github.com/loro-dev/lody/commit/5fadb5de54ed9a04a0c185eb423d6100a025bac4))
- restore gh auth fallback wrapper
  ([#1643](https://github.com/loro-dev/lody/issues/1643))
  ([45c2266](https://github.com/loro-dev/lody/commit/45c226654f5795336c9850bcb6a245bb48290ca0))
- scope injected system prompts to GitHub worktrees
  ([#1590](https://github.com/loro-dev/lody/issues/1590))
  ([5e4bf0e](https://github.com/loro-dev/lody/commit/5e4bf0e16e674cbca3a7262578f5f84cdbe81afd))
- stop duplicate agent configs and stale web online state
  ([#1503](https://github.com/loro-dev/lody/issues/1503))
  ([64deeea](https://github.com/loro-dev/lody/commit/64deeea78304e4ab852ee828e2ecd5827bfa595b))
- stop persisting available commands in history
  ([#1419](https://github.com/loro-dev/lody/issues/1419))
  ([0dfca6a](https://github.com/loro-dev/lody/commit/0dfca6a91798853238e2e10f7cbb0f83924f89fc))
- stop persisting cli acp logs
  ([#1658](https://github.com/loro-dev/lody/issues/1658))
  ([ff25f8f](https://github.com/loro-dev/lody/commit/ff25f8fdb795f4240ae4c5f8ec7d3c304ab3d7ca))
- terminate local acp process groups
  ([#1591](https://github.com/loro-dev/lody/issues/1591))
  ([240592a](https://github.com/loro-dev/lody/commit/240592a296b36f0ca4780ff0e8036de0c4ac0188))
- throttle concurrent file diff loads and prevent layout shifts
  ([#1687](https://github.com/loro-dev/lody/issues/1687))
  ([64dd442](https://github.com/loro-dev/lody/commit/64dd442abdac0d5d414f52113e6b696fce91774b))
- throttle concurrent file operations in code session to prevent CPU blocking
  ([#1442](https://github.com/loro-dev/lody/issues/1442))
  ([51aafb3](https://github.com/loro-dev/lody/commit/51aafb3ffee70fabf03126ca9ed345a951e57265))
- trigger cli release
  ([f74b69b](https://github.com/loro-dev/lody/commit/f74b69b9be7e700af4eda12b10a2a416c40efa68))
- trigger new cli release
  ([7e4432e](https://github.com/loro-dev/lody/commit/7e4432ea081e75d0f2ceb14b0139ec866c363d28))
- truncate CLI API key machine names
  ([#1782](https://github.com/loro-dev/lody/issues/1782))
  ([4982c3c](https://github.com/loro-dev/lody/commit/4982c3c6a21eec77bbc59fdeefa1cdef22fa4099))
- use dynamic auth token getter for Loro Streams token provider
  ([#1505](https://github.com/loro-dev/lody/issues/1505))
  ([b9f12cf](https://github.com/loro-dev/lody/commit/b9f12cfb2e3e00161c14286e65fcebd4acd915bc))
- use formatErrorMessage for session restore errors
  ([#1473](https://github.com/loro-dev/lody/issues/1473))
  ([3bc1b1d](https://github.com/loro-dev/lody/commit/3bc1b1de0345dc252b97e07ccfd272200addfa10))
- use upstream Loro Streams recovery APIs
  ([#1684](https://github.com/loro-dev/lody/issues/1684))
  ([127056f](https://github.com/loro-dev/lody/commit/127056f7abc233f4e5a26ee8901b84a8126452f6))
- wait for code session diff sync
  ([#1699](https://github.com/loro-dev/lody/issues/1699))
  ([1e15d73](https://github.com/loro-dev/lody/commit/1e15d73f20e127b38cd864f354d9542eb472ee26))

### Performance

- batch ACP history updates
  ([#1690](https://github.com/loro-dev/lody/issues/1690))
  ([33210d7](https://github.com/loro-dev/lody/commit/33210d7f933d97732c0d358409f57015b88c1764))

### Refactors

- **cli:** prefer local gh auth over backend OAuth tokens
  ([#1582](https://github.com/loro-dev/lody/issues/1582))
  ([948c34f](https://github.com/loro-dev/lody/commit/948c34fe92b880789f0e0c2a6bffbd205d98009a))
- drop CLI token machine binding
  ([#1860](https://github.com/loro-dev/lody/issues/1860))
  ([0fb1298](https://github.com/loro-dev/lody/commit/0fb129841484f5d341181d06d717d519dbca3084))
- merge enrichment passes and clean up ACP history module
  ([#1779](https://github.com/loro-dev/lody/issues/1779))
  ([59de2fe](https://github.com/loro-dev/lody/commit/59de2feaf838ac58672f692d304c1c007550245b))
- remove AgentClient yolo/modes/models/commands fields, use legacy
  setSessionMode for codex
  ([#1450](https://github.com/loro-dev/lody/issues/1450))
  ([f97131b](https://github.com/loro-dev/lody/commit/f97131b43753b76dd204107034fcb1ad9055ab91))
- remove Convex LoroDoc sync indirection
  ([#1504](https://github.com/loro-dev/lody/issues/1504))
  ([7f80b82](https://github.com/loro-dev/lody/commit/7f80b822b00d10f4a55b39b232a2d8f21b1d35b7))
- remove session owner registry
  ([#1846](https://github.com/loro-dev/lody/issues/1846))
  ([54dcc6e](https://github.com/loro-dev/lody/commit/54dcc6e04453443aaae5f4a72274d6fab19e7d1d))
- replace gh-shim PR interception with post-turn PR detection
  ([#1597](https://github.com/loro-dev/lody/issues/1597))
  ([a3d9990](https://github.com/loro-dev/lody/commit/a3d999043c3e2dae52a19482c37a6c60eb0d1367))
- switch soft delete semantics to e-prefix existence flags
  ([#1511](https://github.com/loro-dev/lody/issues/1511))
  ([1e5ad60](https://github.com/loro-dev/lody/commit/1e5ad600b1ae9f34234ef0e9d04c9e06ebd24a94))

### Documentation

- plan machine + agent config settings refactor
  ([#1853](https://github.com/loro-dev/lody/issues/1853))
  ([751d397](https://github.com/loro-dev/lody/commit/751d3976619d3abb03ba599d830e30b5a57f19b6))

## [0.45.1](https://github.com/loro-dev/lody/compare/lody-cli-v0.45.0...lody-cli-v0.45.1) (2026-04-22)

### Bug Fixes

- **cli:** simplify dispatch history sync recovery
  ([#1882](https://github.com/loro-dev/lody/issues/1882))
  ([5aac7d8](https://github.com/loro-dev/lody/commit/5aac7d8b0f91cfb9f7c28e8f1f8d6c989f2676b6))

## [0.45.0](https://github.com/loro-dev/lody/compare/lody-cli-v0.44.0...lody-cli-v0.45.0) (2026-04-22)

### Features

- add fast mode config toggle
  ([#1842](https://github.com/loro-dev/lody/issues/1842))
  ([984adf9](https://github.com/loro-dev/lody/commit/984adf95f4c53fe3f971967ab388ca33b6d40483))
- **cli:** add daemon restart subcommand
  ([#1824](https://github.com/loro-dev/lody/issues/1824))
  ([c1e8531](https://github.com/loro-dev/lody/commit/c1e8531d9978a0efef2924a44b0ce6543e249e98))
- **cli:** fail fast when the local daemon is not running
  ([#1832](https://github.com/loro-dev/lody/issues/1832))
  ([1f702e0](https://github.com/loro-dev/lody/commit/1f702e0bcf768fe81c6153d58bfae455d2acffb0))
- release 260422 ([#1879](https://github.com/loro-dev/lody/issues/1879))
  ([150961f](https://github.com/loro-dev/lody/commit/150961f36329fca28168b2861590d2faed6dae25))

## [0.44.2-next.1](https://github.com/loro-dev/lody/compare/lody-cli-v0.44.1-next.1...lody-cli-v0.44.2-next.1) (2026-04-22)

### Bug Fixes

- **auth:** show only manual CLI tokens in account settings
  ([#1870](https://github.com/loro-dev/lody/issues/1870))
  ([80bbbe6](https://github.com/loro-dev/lody/commit/80bbbe6d88363e31e52890052b79a29351594929))
- bind manual CLI tokens on first machine use
  ([#1855](https://github.com/loro-dev/lody/issues/1855))
  ([e8767ea](https://github.com/loro-dev/lody/commit/e8767ea902e313a538f3d1492b6d8baf3d2e8de5))
- **cli:** cap dispatch recovery retries
  ([#1875](https://github.com/loro-dev/lody/issues/1875))
  ([af6d408](https://github.com/loro-dev/lody/commit/af6d40841a1a64a2483a4ba666becf7a9c3018d6))
- **cli:** recover Loro metadata stream disconnects
  ([#1828](https://github.com/loro-dev/lody/issues/1828))
  ([0750051](https://github.com/loro-dev/lody/commit/0750051a738328f616f5540badb880ffe363ffca))
- **cli:** retry dispatch after missing session history sync
  ([#1864](https://github.com/loro-dev/lody/issues/1864))
  ([252cd25](https://github.com/loro-dev/lody/commit/252cd252dd8217f280012823f0dffc75218b4a44))
- **cli:** stop commit prompts after cancellation
  ([#1877](https://github.com/loro-dev/lody/issues/1877))
  ([61c7a67](https://github.com/loro-dev/lody/commit/61c7a6762a0d1405424203d68d91626ae81c4619))
- **components:** prevent PR drawer swipe from opening sidebar
  ([#1876](https://github.com/loro-dev/lody/issues/1876))
  ([da6e9f7](https://github.com/loro-dev/lody/commit/da6e9f73ced4d8372b63c3a7ad7dffd10df2e30f))
- **components:** restore legacy session agent config labels
  ([#1871](https://github.com/loro-dev/lody/issues/1871))
  ([16af363](https://github.com/loro-dev/lody/commit/16af3639596f50cfc7b81b14562851dea0e2e4d9))
- **components:** sync pending invitations on workspace switch and add cancel
  ([#1820](https://github.com/loro-dev/lody/issues/1820))
  ([0905a29](https://github.com/loro-dev/lody/commit/0905a294e2f4a01935ee8a0aa16653d6b3e1318c))
- **cli:** retry dispatch after missing session history sync
  ([#1864](https://github.com/loro-dev/lody/issues/1864))
  ([252cd25](https://github.com/loro-dev/lody/commit/252cd252dd8217f280012823f0dffc75218b4a44))
- **cli:** simplify dispatch history sync recovery
  ([#1882](https://github.com/loro-dev/lody/issues/1882))
  ([5aac7d8](https://github.com/loro-dev/lody/commit/5aac7d8b0f91cfb9f7c28e8f1f8d6c989f2676b6))
- **cli:** stop commit prompts after cancellation
  ([#1877](https://github.com/loro-dev/lody/issues/1877))
  ([61c7a67](https://github.com/loro-dev/lody/commit/61c7a6762a0d1405424203d68d91626ae81c4619))
- **components:** prevent PR drawer swipe from opening sidebar
  ([#1876](https://github.com/loro-dev/lody/issues/1876))
  ([da6e9f7](https://github.com/loro-dev/lody/commit/da6e9f73ced4d8372b63c3a7ad7dffd10df2e30f))
- **components:** restore legacy session agent config labels
  ([#1871](https://github.com/loro-dev/lody/issues/1871))
  ([16af363](https://github.com/loro-dev/lody/commit/16af3639596f50cfc7b81b14562851dea0e2e4d9))

### Refactors

- drop CLI token machine binding
  ([#1860](https://github.com/loro-dev/lody/issues/1860))
  ([0fb1298](https://github.com/loro-dev/lody/commit/0fb129841484f5d341181d06d717d519dbca3084))
- remove session owner registry
  ([#1846](https://github.com/loro-dev/lody/issues/1846))
  ([54dcc6e](https://github.com/loro-dev/lody/commit/54dcc6e04453443aaae5f4a72274d6fab19e7d1d))

### Documentation

- plan machine + agent config settings refactor
  ([#1853](https://github.com/loro-dev/lody/issues/1853))
  ([751d397](https://github.com/loro-dev/lody/commit/751d3976619d3abb03ba599d830e30b5a57f19b6))

## [0.44.1-next.1](https://github.com/loro-dev/lody/compare/lody-cli-v0.44.0-next.1...lody-cli-v0.44.1-next.1) (2026-04-19)

### Features

- add --heartbeat-log mode to cli start command
  ([#1479](https://github.com/loro-dev/lody/issues/1479))
  ([9f551df](https://github.com/loro-dev/lody/commit/9f551dff18919ece32b1cf820d87ce848d7ef8aa))
- add cli session export command
  ([#1446](https://github.com/loro-dev/lody/issues/1446))
  ([642db51](https://github.com/loro-dev/lody/commit/642db5179d8b16ce2346fbfcba607a59034ca1e1))
- add fast mode config toggle
  ([#1842](https://github.com/loro-dev/lody/issues/1842))
  ([984adf9](https://github.com/loro-dev/lody/commit/984adf95f4c53fe3f971967ab388ca33b6d40483))
- add github list cli command
  ([#1522](https://github.com/loro-dev/lody/issues/1522))
  ([a29d55f](https://github.com/loro-dev/lody/commit/a29d55f51612138ec6ab7b7d7da9319cec5f4314))
- add Lody Full Access mode
  ([#1791](https://github.com/loro-dev/lody/issues/1791))
  ([4c22cd1](https://github.com/loro-dev/lody/commit/4c22cd1ec0e800c46bdfde51ab87cc1da3721590))
- add lodyFullAccess config for auto-approving agent permissions
  ([#1790](https://github.com/loro-dev/lody/issues/1790))
  ([b2aaa5c](https://github.com/loro-dev/lody/commit/b2aaa5caf5d2b30ca3673455efdfbe274aa82ae8))
- add native OneSignal push support for mobile
  ([#1610](https://github.com/loro-dev/lody/issues/1610))
  ([ca7f08b](https://github.com/loro-dev/lody/commit/ca7f08bf0269c0745e3826a8543f070671b88d2b))
- add non-interactive CLI auth
  ([#1770](https://github.com/loro-dev/lody/issues/1770))
  ([e27afa5](https://github.com/loro-dev/lody/commit/e27afa59704708e9deffd58cbbb5a0a00c11b57b))
- add posthog usage telemetry
  ([#1721](https://github.com/loro-dev/lody/issues/1721))
  ([5c016fd](https://github.com/loro-dev/lody/commit/5c016fdaa2f41f0cd3d03ac62a19e29116e644b3))
- add team machine visibility controls
  ([#1806](https://github.com/loro-dev/lody/issues/1806))
  ([35b7674](https://github.com/loro-dev/lody/commit/35b76745ec873b3a979b69a890ca5a4d7d564660))
- auto-populate title generation defaults for builtin agent configs
  ([#1452](https://github.com/loro-dev/lody/issues/1452))
  ([8da128b](https://github.com/loro-dev/lody/commit/8da128bbb3683f2f3704723f470d4862d23057ac))
- **cli:** add daemon mode and extract cli-supervisor package
  ([#1568](https://github.com/loro-dev/lody/issues/1568))
  ([d45af11](https://github.com/loro-dev/lody/commit/d45af11722e57b486d30a1b02829829f98343d20))
- **cli:** add daemon restart subcommand
  ([#1824](https://github.com/loro-dev/lody/issues/1824))
  ([c1e8531](https://github.com/loro-dev/lody/commit/c1e8531d9978a0efef2924a44b0ce6543e249e98))
- **cli:** auto commit and push for PR-linked sessions
  ([#1512](https://github.com/loro-dev/lody/issues/1512))
  ([d8b064f](https://github.com/loro-dev/lody/commit/d8b064fb4df55a54634db68aba3edb403a992c1b))
- **cli:** fail fast when the local daemon is not running
  ([#1832](https://github.com/loro-dev/lody/issues/1832))
  ([1f702e0](https://github.com/loro-dev/lody/commit/1f702e0bcf768fe81c6153d58bfae455d2acffb0))
- **cli:** support ACP loadSession for native session resume
  ([#1541](https://github.com/loro-dev/lody/issues/1541))
  ([efc4042](https://github.com/loro-dev/lody/commit/efc404209def58fea76b5b534c1cdc54e64cc118))
- **cli:** unify session GC with memory pressure eviction
  ([#1565](https://github.com/loro-dev/lody/issues/1565))
  ([6970429](https://github.com/loro-dev/lody/commit/6970429a1c7fc771e5b81f2ecbd63554ab927d0e))
- complete ACP adapter integration for OpenCode and Kimi
  ([#1766](https://github.com/loro-dev/lody/issues/1766))
  ([e459838](https://github.com/loro-dev/lody/commit/e459838b05c932d8c5c4e86d3c0f8723c13d84ef))
- complete Effect session lifecycle phase 1
  ([#1754](https://github.com/loro-dev/lody/issues/1754))
  ([0986c8f](https://github.com/loro-dev/lody/commit/0986c8f8d7e320eb4c9cdd6a8d3f55072c6f4d91))
- complete loro streams migration
  ([#1404](https://github.com/loro-dev/lody/issues/1404))
  ([177bf05](https://github.com/loro-dev/lody/commit/177bf0549126cf7fc8b573be8e08b6254ee9c59c))
- **components:** add session pin for context recall
  ([#1530](https://github.com/loro-dev/lody/issues/1530))
  ([e207266](https://github.com/loro-dev/lody/commit/e2072661783849b1541cac39716771d12767878c))
- diff comment system ([#1679](https://github.com/loro-dev/lody/issues/1679))
  ([e968685](https://github.com/loro-dev/lody/commit/e968685410fc693db8359eb6e35f953508a50e5a))
- enable registry ACP agents (OpenCode, Kimi) on chat landing
  ([#1764](https://github.com/loro-dev/lody/issues/1764))
  ([92dc297](https://github.com/loro-dev/lody/commit/92dc297f94827a23944a0c118cff2312a4ec1007))
- expand posthog instrumentation
  ([#1397](https://github.com/loro-dev/lody/issues/1397))
  ([9a65bff](https://github.com/loro-dev/lody/commit/9a65bff9af96232986c6de523830e8ef5b1be425))
- filter lock file diffs in viewer
  ([#1649](https://github.com/loro-dev/lody/issues/1649))
  ([ebb6927](https://github.com/loro-dev/lody/commit/ebb6927e55b9542833d4ef6c082faa6f4b6615ed))
- make builtin agent config options dynamic
  ([#1413](https://github.com/loro-dev/lody/issues/1413))
  ([e2b95ef](https://github.com/loro-dev/lody/commit/e2b95efd5f7d75ffcc22532491a41ef0ae78724f))
- migrate builtin agents to unified setSessionConfigOption API
  ([#1407](https://github.com/loro-dev/lody/issues/1407))
  ([ff2c79b](https://github.com/loro-dev/lody/commit/ff2c79b0712a9b79d04da3a2d7facad39f4b9e72))
- multi-tab session ([#1438](https://github.com/loro-dev/lody/issues/1438))
  ([ee7b939](https://github.com/loro-dev/lody/commit/ee7b939ebb3d95ab5a52b7fb717f881de24ab128))
- persist availableCommands from ACP available_commands_update
  ([#1414](https://github.com/loro-dev/lody/issues/1414))
  ([7bb3ba2](https://github.com/loro-dev/lody/commit/7bb3ba22d31c00d6bfbfb110978644e9afe0d37a))
- prevent system sleep while sessions are running
  ([#1357](https://github.com/loro-dev/lody/issues/1357))
  ([2c87b9d](https://github.com/loro-dev/lody/commit/2c87b9d8758bd995295df84b20ff10904614251d))
- release 2026-03-18 ([#1389](https://github.com/loro-dev/lody/issues/1389))
  ([0aec1e5](https://github.com/loro-dev/lody/commit/0aec1e5de84886bc1d935243fdca5f9fbd5829a3))
- release 2026-03-19
  ([8796e6e](https://github.com/loro-dev/lody/commit/8796e6e17cfa8b6ffc90986598b46c059d97ac09))
- release 2026-03-20 ([#1421](https://github.com/loro-dev/lody/issues/1421))
  ([0f17bb9](https://github.com/loro-dev/lody/commit/0f17bb934e53be702a5cbf286e30d35052ef8af7))
- release 2026-03-24 ([#1455](https://github.com/loro-dev/lody/issues/1455))
  ([80b6f82](https://github.com/loro-dev/lody/commit/80b6f828fd539b70874acb4cbb5b946f718651df))
- release 2026-0317 ([#1372](https://github.com/loro-dev/lody/issues/1372))
  ([d3d7812](https://github.com/loro-dev/lody/commit/d3d7812d577271cb8636306b2dbd7dc1788d0340))
- **shared:** add static title generation defaults for builtin agent configs
  ([#1552](https://github.com/loro-dev/lody/issues/1552))
  ([9abf530](https://github.com/loro-dev/lody/commit/9abf5303051bb78339a7c6f84186ac3f82422435))
- stream structured session output for create and chat
  ([#1517](https://github.com/loro-dev/lody/issues/1517))
  ([aa009b1](https://github.com/loro-dev/lody/commit/aa009b10b02217715f1f936d6881e60383e81b89))
- support title generation for all ACP agents
  ([#1440](https://github.com/loro-dev/lody/issues/1440))
  ([9211184](https://github.com/loro-dev/lody/commit/92111846a41579d37efd669fd14050ca702657d9))
- unify file/diff viewer tabs into session tab bar
  ([#1470](https://github.com/loro-dev/lody/issues/1470))
  ([adcb217](https://github.com/loro-dev/lody/commit/adcb21797b58bf043a8b91bccf47ac8232ffdcf9))
- upgrade acp
  ([513fcfd](https://github.com/loro-dev/lody/commit/513fcfdabb9f83935c170a704cfa23e545a7f7a5))
- upgrade acp ([#1366](https://github.com/loro-dev/lody/issues/1366))
  ([2fafde1](https://github.com/loro-dev/lody/commit/2fafde15cbe2408f9d5f92e2d3123dbff46c51c9))

### Bug Fixes

- acp unsupport config option
  ([#1426](https://github.com/loro-dev/lody/issues/1426))
  ([96a0695](https://github.com/loro-dev/lody/commit/96a06956950b9dcb17e34fd1fb5065cea49d95ee))
- add backward compatibility fallback for setSessionConfigOption
  ([#1424](https://github.com/loro-dev/lody/issues/1424))
  ([7f45585](https://github.com/loro-dev/lody/commit/7f45585702a07ab98885bf1c98d15820be81fb23))
- allow client start without required cli installs
  ([#1608](https://github.com/loro-dev/lody/issues/1608))
  ([beb184d](https://github.com/loro-dev/lody/commit/beb184d42520b4f080f4d49815642bc7d5e0e440))
- cli deps
  ([7a44905](https://github.com/loro-dev/lody/commit/7a44905e398ca487f0a9033959f24b1a0b4e9df9))
- cli packaging err
  ([79842ed](https://github.com/loro-dev/lody/commit/79842edeebfcacf7a44bc5207e960fb784a27ba7))
- cli release please
  ([874903c](https://github.com/loro-dev/lody/commit/874903c8bd2c74c0f953a08a7f083bce259a0aec))
- cli zstd wasm packaging
  ([#1734](https://github.com/loro-dev/lody/issues/1734))
  ([4051e76](https://github.com/loro-dev/lody/commit/4051e76ad3bf1b66da8c52a68bf9e0427d6f06d7))
- **cli:** deduplicate machine ID in Docker by appending random suffix
  ([#1810](https://github.com/loro-dev/lody/issues/1810))
  ([1355081](https://github.com/loro-dev/lody/commit/135508153db2d770cec4d64f29eb44ec7fc8a2ec))
- **cli:** diagnostic logging for stream_not_found room join errors
  ([#1553](https://github.com/loro-dev/lody/issues/1553))
  ([b22b9c0](https://github.com/loro-dev/lody/commit/b22b9c04ee05b5ee32c3139c067bfc50188a1650))
- **cli:** fix process leak and aggregate per-session state
  ([#1539](https://github.com/loro-dev/lody/issues/1539))
  ([dab6e5d](https://github.com/loro-dev/lody/commit/dab6e5d3fd42e4ded60a7eba9824b693ffa8aadf))
- **cli:** fix session dispatch bugs for old and new sessions
  ([#1519](https://github.com/loro-dev/lody/issues/1519))
  ([484e956](https://github.com/loro-dev/lody/commit/484e9560ede663b29119e12199dc72eceb14d15e))
- **cli:** lazily join session rooms instead of eagerly connecting all on
  startup ([#1569](https://github.com/loro-dev/lody/issues/1569))
  ([1cae649](https://github.com/loro-dev/lody/commit/1cae649cf05a19cc289caa8f9d3f68702a1dbb49))
- **cli:** recover Loro metadata stream disconnects
  ([#1828](https://github.com/loro-dev/lody/issues/1828))
  ([0750051](https://github.com/loro-dev/lody/commit/0750051a738328f616f5540badb880ffe363ffca))
- **cli:** reduce ACP idle timeout from 3 hours to 30 minutes
  ([#1515](https://github.com/loro-dev/lody/issues/1515))
  ([b52ea81](https://github.com/loro-dev/lody/commit/b52ea8184de83210a269f6f0984807f7812c63e3))
- **cli:** reduce default info log noise
  ([#1720](https://github.com/loro-dev/lody/issues/1720))
  ([220a7b5](https://github.com/loro-dev/lody/commit/220a7b5da94b9c9bd24546364e0b525abd01f48e))
- **cli:** replace posthog-node with http client
  ([#1465](https://github.com/loro-dev/lody/issues/1465))
  ([01c48e9](https://github.com/loro-dev/lody/commit/01c48e901d848e8b7b2bd96416c904d2dc674d8e))
- **cli:** resolve CLI not responding to web-initiated sessions
  ([#1570](https://github.com/loro-dev/lody/issues/1570))
  ([c2308bb](https://github.com/loro-dev/lody/commit/c2308bb7b9ee42779f68bae60977df70b1b6fe3b))
- **cli:** reuse non-default worktree branches
  ([#1811](https://github.com/loro-dev/lody/issues/1811))
  ([73ecd16](https://github.com/loro-dev/lody/commit/73ecd168822da22f19f613a7c5e0e29ba2368142))
- **cli:** run fleet.shutdown() on uncaught exceptions to release ports
  ([#1391](https://github.com/loro-dev/lody/issues/1391))
  ([f5cf3ef](https://github.com/loro-dev/lody/commit/f5cf3ef68c0236219bfb5f4f18e400ea47f952fd))
- **cli:** set turnId before applyAcpModeAndModel to prevent ACP flush error
  ([#1418](https://github.com/loro-dev/lody/issues/1418))
  ([eee7524](https://github.com/loro-dev/lody/commit/eee752465314afb34f4596dc9d5b320ed4597081))
- **cli:** skip auto commit after cancelled turn
  ([#1671](https://github.com/loro-dev/lody/issues/1671))
  ([6db2256](https://github.com/loro-dev/lody/commit/6db2256a80750dfae78b19f08b4224de4d0f311b))
- **cli:** suppress acp replay during session restore
  ([#1562](https://github.com/loro-dev/lody/issues/1562))
  ([f84e83b](https://github.com/loro-dev/lody/commit/f84e83bbc5cbdddc82259c7832ae8c1b624ff0eb))
- **cli:** translate build prompt instructions
  ([#1753](https://github.com/loro-dev/lody/issues/1753))
  ([f363486](https://github.com/loro-dev/lody/commit/f363486bb48e4a5e96508ced2ac3fd396db2b1a8))
- close acp sessions before process teardown
  ([#1554](https://github.com/loro-dev/lody/issues/1554))
  ([54bfccc](https://github.com/loro-dev/lody/commit/54bfccc0c624dc716b731b9a009c85fd5b5cdfda))
- **components:** route session quick actions to active tab
  ([#1518](https://github.com/loro-dev/lody/issues/1518))
  ([214aa97](https://github.com/loro-dev/lody/commit/214aa9762cffb88a22b1cfa2409e0f459e4d6ac6))
- **components:** sync pending invitations on workspace switch and add cancel
  ([#1820](https://github.com/loro-dev/lody/issues/1820))
  ([0905a29](https://github.com/loro-dev/lody/commit/0905a294e2f4a01935ee8a0aa16653d6b3e1318c))
- defer child tab session creation and reuse parent workdir
  ([#1490](https://github.com/loro-dev/lody/issues/1490))
  ([aa475bf](https://github.com/loro-dev/lody/commit/aa475bfc2915bb94cabebed21d53e53109572ef3))
- display specific ACP error reasons in chat failure notices
  ([80b6f82](https://github.com/loro-dev/lody/commit/80b6f828fd539b70874acb4cbb5b946f718651df))
- don't terminate session on transient upstream API errors (500/529)
  ([#1538](https://github.com/loro-dev/lody/issues/1538))
  ([6d12e96](https://github.com/loro-dev/lody/commit/6d12e963af75eeddcc768289775113d5af66036b))
- enable automatic snapshot upload on streams-crdt
  ([#1462](https://github.com/loro-dev/lody/issues/1462))
  ([374157b](https://github.com/loro-dev/lody/commit/374157b1f1c28cdc3f230b6dcc8a3463f0b3de48))
- extract detailed error message from ACP error data.message field
  ([#1448](https://github.com/loro-dev/lody/issues/1448))
  ([680985b](https://github.com/loro-dev/lody/commit/680985b172b5b76399ad3442cb2fd92a57f0561e))
- force official registry for codex acp
  ([#1616](https://github.com/loro-dev/lody/issues/1616))
  ([8d6a57f](https://github.com/loro-dev/lody/commit/8d6a57f4f119b244607938d48238bfeefc54cb82))
- handle empty remote repos in worktree creation
  ([#1441](https://github.com/loro-dev/lody/issues/1441))
  ([99e8805](https://github.com/loro-dev/lody/commit/99e8805f658b38850b546fb7f6e0dcf4d0845f07))
- keep permission requests on active turn
  ([#1799](https://github.com/loro-dev/lody/issues/1799))
  ([177be84](https://github.com/loro-dev/lody/commit/177be8477958189ad2f041f617683f4de52a2a6a))
- make CLI start shutdown interruptible
  ([#1675](https://github.com/loro-dev/lody/issues/1675))
  ([ae1cc5f](https://github.com/loro-dev/lody/commit/ae1cc5ff6113400ae586865309d4e540948826b4))
- make session heartbeat scoped and nonblocking
  ([#1775](https://github.com/loro-dev/lody/issues/1775))
  ([828e859](https://github.com/loro-dev/lody/commit/828e859fb1d20b97877d8bf00d15a71c326b3f47))
- make session resource limits cgroup-aware to prevent machine lockups
  ([#1622](https://github.com/loro-dev/lody/issues/1622))
  ([3a2933c](https://github.com/loro-dev/lody/commit/3a2933c4c9304dba06078a74a44aa5ceeea13121))
- normalize CLI process resource profiles
  ([#1749](https://github.com/loro-dev/lody/issues/1749))
  ([02f5672](https://github.com/loro-dev/lody/commit/02f56722bccefc8f6e352dfe537e4e927172b496))
- parse Kimi ACP terminal, read, and edit notifications into Loro history
  ([#1776](https://github.com/loro-dev/lody/issues/1776))
  ([8a8cb94](https://github.com/loro-dev/lody/commit/8a8cb94c1066f0854cdc8f0647beda18435ca992))
- persist active session tab in URL
  ([#1625](https://github.com/loro-dev/lody/issues/1625))
  ([474f17e](https://github.com/loro-dev/lody/commit/474f17ee8cc28d8210510b0b4d0012f29a2c0a27))
- preserve image blocks with null metadata
  ([#1712](https://github.com/loro-dev/lody/issues/1712))
  ([f34638d](https://github.com/loro-dev/lody/commit/f34638d70f9a2c590070879e4d49aa8bb7150a4c))
- prompt
  ([84741f5](https://github.com/loro-dev/lody/commit/84741f5ef273e3e379e66f9b2ccd994aa999b3ab))
- recover disconnected streams rooms on visibility change
  ([#1474](https://github.com/loro-dev/lody/issues/1474))
  ([e98e4b9](https://github.com/loro-dev/lody/commit/e98e4b93ba87288f42250655b35bc595edcd3154))
- recover stale local CLI servers on startup
  ([39995b7](https://github.com/loro-dev/lody/commit/39995b7dc7c79cfd737fbcf760fbcb5cae3ace23))
- reduce cli log volume and retention
  ([#1628](https://github.com/loro-dev/lody/issues/1628))
  ([2904dcd](https://github.com/loro-dev/lody/commit/2904dcdcf0d9e19ead1f4fb1be47f135acac0aa0))
- refresh GH_TOKEN at turn start instead of turn end
  ([#1613](https://github.com/loro-dev/lody/issues/1613))
  ([423e8b9](https://github.com/loro-dev/lody/commit/423e8b9cf23d4d0eb1aa0d1a6dc719a655af42d1))
- refresh stale acp capabilities
  ([#1744](https://github.com/loro-dev/lody/issues/1744))
  ([00d1573](https://github.com/loro-dev/lody/commit/00d1573785621247f1195b5f4b518ea5035e3d12))
- repair packaged electron cli startup
  ([#1727](https://github.com/loro-dev/lody/issues/1727))
  ([a8fc91c](https://github.com/loro-dev/lody/commit/a8fc91cfd5f5a39d4d96d5b26a5085729110d902))
- resolve Full Access auto-approve not working for kimi and legacy-mode agents
  ([#1796](https://github.com/loro-dev/lody/issues/1796))
  ([5fadb5d](https://github.com/loro-dev/lody/commit/5fadb5de54ed9a04a0c185eb423d6100a025bac4))
- restore gh auth fallback wrapper
  ([#1643](https://github.com/loro-dev/lody/issues/1643))
  ([45c2266](https://github.com/loro-dev/lody/commit/45c226654f5795336c9850bcb6a245bb48290ca0))
- scope injected system prompts to GitHub worktrees
  ([#1590](https://github.com/loro-dev/lody/issues/1590))
  ([5e4bf0e](https://github.com/loro-dev/lody/commit/5e4bf0e16e674cbca3a7262578f5f84cdbe81afd))
- stop duplicate agent configs and stale web online state
  ([#1503](https://github.com/loro-dev/lody/issues/1503))
  ([64deeea](https://github.com/loro-dev/lody/commit/64deeea78304e4ab852ee828e2ecd5827bfa595b))
- stop persisting available commands in history
  ([#1419](https://github.com/loro-dev/lody/issues/1419))
  ([0dfca6a](https://github.com/loro-dev/lody/commit/0dfca6a91798853238e2e10f7cbb0f83924f89fc))
- stop persisting cli acp logs
  ([#1658](https://github.com/loro-dev/lody/issues/1658))
  ([ff25f8f](https://github.com/loro-dev/lody/commit/ff25f8fdb795f4240ae4c5f8ec7d3c304ab3d7ca))
- terminate local acp process groups
  ([#1591](https://github.com/loro-dev/lody/issues/1591))
  ([240592a](https://github.com/loro-dev/lody/commit/240592a296b36f0ca4780ff0e8036de0c4ac0188))
- throttle concurrent file diff loads and prevent layout shifts
  ([#1687](https://github.com/loro-dev/lody/issues/1687))
  ([64dd442](https://github.com/loro-dev/lody/commit/64dd442abdac0d5d414f52113e6b696fce91774b))
- throttle concurrent file operations in code session to prevent CPU blocking
  ([#1442](https://github.com/loro-dev/lody/issues/1442))
  ([51aafb3](https://github.com/loro-dev/lody/commit/51aafb3ffee70fabf03126ca9ed345a951e57265))
- trigger new cli release
  ([7e4432e](https://github.com/loro-dev/lody/commit/7e4432ea081e75d0f2ceb14b0139ec866c363d28))
- truncate CLI API key machine names
  ([#1782](https://github.com/loro-dev/lody/issues/1782))
  ([4982c3c](https://github.com/loro-dev/lody/commit/4982c3c6a21eec77bbc59fdeefa1cdef22fa4099))
- use dynamic auth token getter for Loro Streams token provider
  ([#1505](https://github.com/loro-dev/lody/issues/1505))
  ([b9f12cf](https://github.com/loro-dev/lody/commit/b9f12cfb2e3e00161c14286e65fcebd4acd915bc))
- use formatErrorMessage for session restore errors
  ([#1473](https://github.com/loro-dev/lody/issues/1473))
  ([3bc1b1d](https://github.com/loro-dev/lody/commit/3bc1b1de0345dc252b97e07ccfd272200addfa10))
- use upstream Loro Streams recovery APIs
  ([#1684](https://github.com/loro-dev/lody/issues/1684))
  ([127056f](https://github.com/loro-dev/lody/commit/127056f7abc233f4e5a26ee8901b84a8126452f6))
- wait for code session diff sync
  ([#1699](https://github.com/loro-dev/lody/issues/1699))
  ([1e15d73](https://github.com/loro-dev/lody/commit/1e15d73f20e127b38cd864f354d9542eb472ee26))

### Performance

- batch ACP history updates
  ([#1690](https://github.com/loro-dev/lody/issues/1690))
  ([33210d7](https://github.com/loro-dev/lody/commit/33210d7f933d97732c0d358409f57015b88c1764))

### Refactors

- **cli:** prefer local gh auth over backend OAuth tokens
  ([#1582](https://github.com/loro-dev/lody/issues/1582))
  ([948c34f](https://github.com/loro-dev/lody/commit/948c34fe92b880789f0e0c2a6bffbd205d98009a))
- merge enrichment passes and clean up ACP history module
  ([#1779](https://github.com/loro-dev/lody/issues/1779))
  ([59de2fe](https://github.com/loro-dev/lody/commit/59de2feaf838ac58672f692d304c1c007550245b))
- remove AgentClient yolo/modes/models/commands fields, use legacy
  setSessionMode for codex
  ([#1450](https://github.com/loro-dev/lody/issues/1450))
  ([f97131b](https://github.com/loro-dev/lody/commit/f97131b43753b76dd204107034fcb1ad9055ab91))
- remove Convex LoroDoc sync indirection
  ([#1504](https://github.com/loro-dev/lody/issues/1504))
  ([7f80b82](https://github.com/loro-dev/lody/commit/7f80b822b00d10f4a55b39b232a2d8f21b1d35b7))
- replace gh-shim PR interception with post-turn PR detection
  ([#1597](https://github.com/loro-dev/lody/issues/1597))
  ([a3d9990](https://github.com/loro-dev/lody/commit/a3d999043c3e2dae52a19482c37a6c60eb0d1367))
- switch soft delete semantics to e-prefix existence flags
  ([#1511](https://github.com/loro-dev/lody/issues/1511))
  ([1e5ad60](https://github.com/loro-dev/lody/commit/1e5ad600b1ae9f34234ef0e9d04c9e06ebd24a94))

## [0.41.18-next.1](https://github.com/loro-dev/lody/compare/lody-cli-v0.41.17-next.1...lody-cli-v0.41.18-next.1) (2026-04-15)

### Bug Fixes

- truncate CLI API key machine names
  ([#1782](https://github.com/loro-dev/lody/issues/1782))
  ([4982c3c](https://github.com/loro-dev/lody/commit/4982c3c6a21eec77bbc59fdeefa1cdef22fa4099))

## [0.41.17-next.1](https://github.com/loro-dev/lody/compare/lody-cli-v0.41.16-next.1...lody-cli-v0.41.17-next.1) (2026-04-15)

### Refactors

- merge enrichment passes and clean up ACP history module
  ([#1779](https://github.com/loro-dev/lody/issues/1779))
  ([59de2fe](https://github.com/loro-dev/lody/commit/59de2feaf838ac58672f692d304c1c007550245b))

## [0.41.16-next.1](https://github.com/loro-dev/lody/compare/lody-cli-v0.41.15-next.1...lody-cli-v0.41.16-next.1) (2026-04-15)

### Bug Fixes

- make session heartbeat scoped and nonblocking
  ([#1775](https://github.com/loro-dev/lody/issues/1775))
  ([828e859](https://github.com/loro-dev/lody/commit/828e859fb1d20b97877d8bf00d15a71c326b3f47))
- parse Kimi ACP terminal, read, and edit notifications into Loro history
  ([#1776](https://github.com/loro-dev/lody/issues/1776))
  ([8a8cb94](https://github.com/loro-dev/lody/commit/8a8cb94c1066f0854cdc8f0647beda18435ca992))

## [0.41.15-next.1](https://github.com/loro-dev/lody/compare/lody-cli-v0.41.14-next.1...lody-cli-v0.41.15-next.1) (2026-04-15)

### Features

- complete ACP adapter integration for OpenCode and Kimi
  ([#1766](https://github.com/loro-dev/lody/issues/1766))
  ([e459838](https://github.com/loro-dev/lody/commit/e459838b05c932d8c5c4e86d3c0f8723c13d84ef))
- complete Effect session lifecycle phase 1
  ([#1754](https://github.com/loro-dev/lody/issues/1754))
  ([0986c8f](https://github.com/loro-dev/lody/commit/0986c8f8d7e320eb4c9cdd6a8d3f55072c6f4d91))
- enable registry ACP agents (OpenCode, Kimi) on chat landing
  ([#1764](https://github.com/loro-dev/lody/issues/1764))
  ([92dc297](https://github.com/loro-dev/lody/commit/92dc297f94827a23944a0c118cff2312a4ec1007))

### Bug Fixes

- **cli:** translate build prompt instructions
  ([#1753](https://github.com/loro-dev/lody/issues/1753))
  ([f363486](https://github.com/loro-dev/lody/commit/f363486bb48e4a5e96508ced2ac3fd396db2b1a8))
- normalize CLI process resource profiles
  ([#1749](https://github.com/loro-dev/lody/issues/1749))
  ([02f5672](https://github.com/loro-dev/lody/commit/02f56722bccefc8f6e352dfe537e4e927172b496))
- refresh stale acp capabilities
  ([#1744](https://github.com/loro-dev/lody/issues/1744))
  ([00d1573](https://github.com/loro-dev/lody/commit/00d1573785621247f1195b5f4b518ea5035e3d12))

## [0.42.0](https://github.com/loro-dev/lody/compare/lody-cli-v0.41.1...lody-cli-v0.42.0) (2026-04-13)

### Features

- add --heartbeat-log mode to cli start command
  ([#1479](https://github.com/loro-dev/lody/issues/1479))
  ([9f551df](https://github.com/loro-dev/lody/commit/9f551dff18919ece32b1cf820d87ce848d7ef8aa))
- add github list cli command
  ([#1522](https://github.com/loro-dev/lody/issues/1522))
  ([a29d55f](https://github.com/loro-dev/lody/commit/a29d55f51612138ec6ab7b7d7da9319cec5f4314))
- add native OneSignal push support for mobile
  ([#1610](https://github.com/loro-dev/lody/issues/1610))
  ([ca7f08b](https://github.com/loro-dev/lody/commit/ca7f08bf0269c0745e3826a8543f070671b88d2b))
- add posthog usage telemetry
  ([#1721](https://github.com/loro-dev/lody/issues/1721))
  ([5c016fd](https://github.com/loro-dev/lody/commit/5c016fdaa2f41f0cd3d03ac62a19e29116e644b3))
- **cli:** add daemon mode and extract cli-supervisor package
  ([#1568](https://github.com/loro-dev/lody/issues/1568))
  ([d45af11](https://github.com/loro-dev/lody/commit/d45af11722e57b486d30a1b02829829f98343d20))
- **cli:** auto commit and push for PR-linked sessions
  ([#1512](https://github.com/loro-dev/lody/issues/1512))
  ([d8b064f](https://github.com/loro-dev/lody/commit/d8b064fb4df55a54634db68aba3edb403a992c1b))
- **cli:** support ACP loadSession for native session resume
  ([#1541](https://github.com/loro-dev/lody/issues/1541))
  ([efc4042](https://github.com/loro-dev/lody/commit/efc404209def58fea76b5b534c1cdc54e64cc118))
- **cli:** unify session GC with memory pressure eviction
  ([#1565](https://github.com/loro-dev/lody/issues/1565))
  ([6970429](https://github.com/loro-dev/lody/commit/6970429a1c7fc771e5b81f2ecbd63554ab927d0e))
- **components:** add session pin for context recall
  ([#1530](https://github.com/loro-dev/lody/issues/1530))
  ([e207266](https://github.com/loro-dev/lody/commit/e2072661783849b1541cac39716771d12767878c))
- diff comment system ([#1679](https://github.com/loro-dev/lody/issues/1679))
  ([e968685](https://github.com/loro-dev/lody/commit/e968685410fc693db8359eb6e35f953508a50e5a))
- filter lock file diffs in viewer
  ([#1649](https://github.com/loro-dev/lody/issues/1649))
  ([ebb6927](https://github.com/loro-dev/lody/commit/ebb6927e55b9542833d4ef6c082faa6f4b6615ed))
- **shared:** add static title generation defaults for builtin agent configs
  ([#1552](https://github.com/loro-dev/lody/issues/1552))
  ([9abf530](https://github.com/loro-dev/lody/commit/9abf5303051bb78339a7c6f84186ac3f82422435))
- stream structured session output for create and chat
  ([#1517](https://github.com/loro-dev/lody/issues/1517))
  ([aa009b1](https://github.com/loro-dev/lody/commit/aa009b10b02217715f1f936d6881e60383e81b89))
- unify file/diff viewer tabs into session tab bar
  ([#1470](https://github.com/loro-dev/lody/issues/1470))
  ([adcb217](https://github.com/loro-dev/lody/commit/adcb21797b58bf043a8b91bccf47ac8232ffdcf9))
- upgrade acp
  ([513fcfd](https://github.com/loro-dev/lody/commit/513fcfdabb9f83935c170a704cfa23e545a7f7a5))

### Bug Fixes

- allow client start without required cli installs
  ([#1608](https://github.com/loro-dev/lody/issues/1608))
  ([beb184d](https://github.com/loro-dev/lody/commit/beb184d42520b4f080f4d49815642bc7d5e0e440))
- cli deps
  ([7a44905](https://github.com/loro-dev/lody/commit/7a44905e398ca487f0a9033959f24b1a0b4e9df9))
- cli zstd wasm packaging
  ([#1734](https://github.com/loro-dev/lody/issues/1734))
  ([4051e76](https://github.com/loro-dev/lody/commit/4051e76ad3bf1b66da8c52a68bf9e0427d6f06d7))
- **cli:** diagnostic logging for stream_not_found room join errors
  ([#1553](https://github.com/loro-dev/lody/issues/1553))
  ([b22b9c0](https://github.com/loro-dev/lody/commit/b22b9c04ee05b5ee32c3139c067bfc50188a1650))
- **cli:** fix process leak and aggregate per-session state
  ([#1539](https://github.com/loro-dev/lody/issues/1539))
  ([dab6e5d](https://github.com/loro-dev/lody/commit/dab6e5d3fd42e4ded60a7eba9824b693ffa8aadf))
- **cli:** fix session dispatch bugs for old and new sessions
  ([#1519](https://github.com/loro-dev/lody/issues/1519))
  ([484e956](https://github.com/loro-dev/lody/commit/484e9560ede663b29119e12199dc72eceb14d15e))
- **cli:** lazily join session rooms instead of eagerly connecting all on
  startup ([#1569](https://github.com/loro-dev/lody/issues/1569))
  ([1cae649](https://github.com/loro-dev/lody/commit/1cae649cf05a19cc289caa8f9d3f68702a1dbb49))
- **cli:** reduce ACP idle timeout from 3 hours to 30 minutes
  ([#1515](https://github.com/loro-dev/lody/issues/1515))
  ([b52ea81](https://github.com/loro-dev/lody/commit/b52ea8184de83210a269f6f0984807f7812c63e3))
- **cli:** reduce default info log noise
  ([#1720](https://github.com/loro-dev/lody/issues/1720))
  ([220a7b5](https://github.com/loro-dev/lody/commit/220a7b5da94b9c9bd24546364e0b525abd01f48e))
- **cli:** resolve CLI not responding to web-initiated sessions
  ([#1570](https://github.com/loro-dev/lody/issues/1570))
  ([c2308bb](https://github.com/loro-dev/lody/commit/c2308bb7b9ee42779f68bae60977df70b1b6fe3b))
- **cli:** skip auto commit after cancelled turn
  ([#1671](https://github.com/loro-dev/lody/issues/1671))
  ([6db2256](https://github.com/loro-dev/lody/commit/6db2256a80750dfae78b19f08b4224de4d0f311b))
- **cli:** suppress acp replay during session restore
  ([#1562](https://github.com/loro-dev/lody/issues/1562))
  ([f84e83b](https://github.com/loro-dev/lody/commit/f84e83bbc5cbdddc82259c7832ae8c1b624ff0eb))
- close acp sessions before process teardown
  ([#1554](https://github.com/loro-dev/lody/issues/1554))
  ([54bfccc](https://github.com/loro-dev/lody/commit/54bfccc0c624dc716b731b9a009c85fd5b5cdfda))
- **components:** route session quick actions to active tab
  ([#1518](https://github.com/loro-dev/lody/issues/1518))
  ([214aa97](https://github.com/loro-dev/lody/commit/214aa9762cffb88a22b1cfa2409e0f459e4d6ac6))
- defer child tab session creation and reuse parent workdir
  ([#1490](https://github.com/loro-dev/lody/issues/1490))
  ([aa475bf](https://github.com/loro-dev/lody/commit/aa475bfc2915bb94cabebed21d53e53109572ef3))
- don't terminate session on transient upstream API errors (500/529)
  ([#1538](https://github.com/loro-dev/lody/issues/1538))
  ([6d12e96](https://github.com/loro-dev/lody/commit/6d12e963af75eeddcc768289775113d5af66036b))
- enable automatic snapshot upload on streams-crdt
  ([#1462](https://github.com/loro-dev/lody/issues/1462))
  ([374157b](https://github.com/loro-dev/lody/commit/374157b1f1c28cdc3f230b6dcc8a3463f0b3de48))
- force official registry for codex acp
  ([#1616](https://github.com/loro-dev/lody/issues/1616))
  ([8d6a57f](https://github.com/loro-dev/lody/commit/8d6a57f4f119b244607938d48238bfeefc54cb82))
- make CLI start shutdown interruptible
  ([#1675](https://github.com/loro-dev/lody/issues/1675))
  ([ae1cc5f](https://github.com/loro-dev/lody/commit/ae1cc5ff6113400ae586865309d4e540948826b4))
- make session resource limits cgroup-aware to prevent machine lockups
  ([#1622](https://github.com/loro-dev/lody/issues/1622))
  ([3a2933c](https://github.com/loro-dev/lody/commit/3a2933c4c9304dba06078a74a44aa5ceeea13121))
- persist active session tab in URL
  ([#1625](https://github.com/loro-dev/lody/issues/1625))
  ([474f17e](https://github.com/loro-dev/lody/commit/474f17ee8cc28d8210510b0b4d0012f29a2c0a27))
- preserve image blocks with null metadata
  ([#1712](https://github.com/loro-dev/lody/issues/1712))
  ([f34638d](https://github.com/loro-dev/lody/commit/f34638d70f9a2c590070879e4d49aa8bb7150a4c))
- recover disconnected streams rooms on visibility change
  ([#1474](https://github.com/loro-dev/lody/issues/1474))
  ([e98e4b9](https://github.com/loro-dev/lody/commit/e98e4b93ba87288f42250655b35bc595edcd3154))
- reduce cli log volume and retention
  ([#1628](https://github.com/loro-dev/lody/issues/1628))
  ([2904dcd](https://github.com/loro-dev/lody/commit/2904dcdcf0d9e19ead1f4fb1be47f135acac0aa0))
- refresh GH_TOKEN at turn start instead of turn end
  ([#1613](https://github.com/loro-dev/lody/issues/1613))
  ([423e8b9](https://github.com/loro-dev/lody/commit/423e8b9cf23d4d0eb1aa0d1a6dc719a655af42d1))
- repair packaged electron cli startup
  ([#1727](https://github.com/loro-dev/lody/issues/1727))
  ([a8fc91c](https://github.com/loro-dev/lody/commit/a8fc91cfd5f5a39d4d96d5b26a5085729110d902))
- restore gh auth fallback wrapper
  ([#1643](https://github.com/loro-dev/lody/issues/1643))
  ([45c2266](https://github.com/loro-dev/lody/commit/45c226654f5795336c9850bcb6a245bb48290ca0))
- scope injected system prompts to GitHub worktrees
  ([#1590](https://github.com/loro-dev/lody/issues/1590))
  ([5e4bf0e](https://github.com/loro-dev/lody/commit/5e4bf0e16e674cbca3a7262578f5f84cdbe81afd))
- stop duplicate agent configs and stale web online state
  ([#1503](https://github.com/loro-dev/lody/issues/1503))
  ([64deeea](https://github.com/loro-dev/lody/commit/64deeea78304e4ab852ee828e2ecd5827bfa595b))
- stop persisting cli acp logs
  ([#1658](https://github.com/loro-dev/lody/issues/1658))
  ([ff25f8f](https://github.com/loro-dev/lody/commit/ff25f8fdb795f4240ae4c5f8ec7d3c304ab3d7ca))
- terminate local acp process groups
  ([#1591](https://github.com/loro-dev/lody/issues/1591))
  ([240592a](https://github.com/loro-dev/lody/commit/240592a296b36f0ca4780ff0e8036de0c4ac0188))
- throttle concurrent file diff loads and prevent layout shifts
  ([#1687](https://github.com/loro-dev/lody/issues/1687))
  ([64dd442](https://github.com/loro-dev/lody/commit/64dd442abdac0d5d414f52113e6b696fce91774b))
- use dynamic auth token getter for Loro Streams token provider
  ([#1505](https://github.com/loro-dev/lody/issues/1505))
  ([b9f12cf](https://github.com/loro-dev/lody/commit/b9f12cfb2e3e00161c14286e65fcebd4acd915bc))
- use formatErrorMessage for session restore errors
  ([#1473](https://github.com/loro-dev/lody/issues/1473))
  ([3bc1b1d](https://github.com/loro-dev/lody/commit/3bc1b1de0345dc252b97e07ccfd272200addfa10))
- use upstream Loro Streams recovery APIs
  ([#1684](https://github.com/loro-dev/lody/issues/1684))
  ([127056f](https://github.com/loro-dev/lody/commit/127056f7abc233f4e5a26ee8901b84a8126452f6))
- wait for code session diff sync
  ([#1699](https://github.com/loro-dev/lody/issues/1699))
  ([1e15d73](https://github.com/loro-dev/lody/commit/1e15d73f20e127b38cd864f354d9542eb472ee26))

### Performance

- batch ACP history updates
  ([#1690](https://github.com/loro-dev/lody/issues/1690))
  ([33210d7](https://github.com/loro-dev/lody/commit/33210d7f933d97732c0d358409f57015b88c1764))

### Refactors

- **cli:** prefer local gh auth over backend OAuth tokens
  ([#1582](https://github.com/loro-dev/lody/issues/1582))
  ([948c34f](https://github.com/loro-dev/lody/commit/948c34fe92b880789f0e0c2a6bffbd205d98009a))
- remove Convex LoroDoc sync indirection
  ([#1504](https://github.com/loro-dev/lody/issues/1504))
  ([7f80b82](https://github.com/loro-dev/lody/commit/7f80b822b00d10f4a55b39b232a2d8f21b1d35b7))
- replace gh-shim PR interception with post-turn PR detection
  ([#1597](https://github.com/loro-dev/lody/issues/1597))
  ([a3d9990](https://github.com/loro-dev/lody/commit/a3d999043c3e2dae52a19482c37a6c60eb0d1367))
- switch soft delete semantics to e-prefix existence flags
  ([#1511](https://github.com/loro-dev/lody/issues/1511))
  ([1e5ad60](https://github.com/loro-dev/lody/commit/1e5ad600b1ae9f34234ef0e9d04c9e06ebd24a94))

## [0.41.14-next.1](https://github.com/loro-dev/lody/compare/lody-cli-v0.41.13-next.1...lody-cli-v0.41.14-next.1) (2026-04-13)

### Bug Fixes

- cli zstd wasm packaging
  ([#1734](https://github.com/loro-dev/lody/issues/1734))
  ([4051e76](https://github.com/loro-dev/lody/commit/4051e76ad3bf1b66da8c52a68bf9e0427d6f06d7))

## [0.41.13-next.1](https://github.com/loro-dev/lody/compare/lody-cli-v0.41.12-next.1...lody-cli-v0.41.13-next.1) (2026-04-13)

### Features

- add posthog usage telemetry
  ([#1721](https://github.com/loro-dev/lody/issues/1721))
  ([5c016fd](https://github.com/loro-dev/lody/commit/5c016fdaa2f41f0cd3d03ac62a19e29116e644b3))

### Bug Fixes

- repair packaged electron cli startup
  ([#1727](https://github.com/loro-dev/lody/issues/1727))
  ([a8fc91c](https://github.com/loro-dev/lody/commit/a8fc91cfd5f5a39d4d96d5b26a5085729110d902))

## [0.41.12-next.1](https://github.com/loro-dev/lody/compare/lody-cli-v0.41.11-next.1...lody-cli-v0.41.12-next.1) (2026-04-13)

### Features

- diff comment system ([#1679](https://github.com/loro-dev/lody/issues/1679))
  ([e968685](https://github.com/loro-dev/lody/commit/e968685410fc693db8359eb6e35f953508a50e5a))

### Bug Fixes

- **cli:** reduce default info log noise
  ([#1720](https://github.com/loro-dev/lody/issues/1720))
  ([220a7b5](https://github.com/loro-dev/lody/commit/220a7b5da94b9c9bd24546364e0b525abd01f48e))
- preserve image blocks with null metadata
  ([#1712](https://github.com/loro-dev/lody/issues/1712))
  ([f34638d](https://github.com/loro-dev/lody/commit/f34638d70f9a2c590070879e4d49aa8bb7150a4c))
- wait for code session diff sync
  ([#1699](https://github.com/loro-dev/lody/issues/1699))
  ([1e15d73](https://github.com/loro-dev/lody/commit/1e15d73f20e127b38cd864f354d9542eb472ee26))

## [0.41.11-next.1](https://github.com/loro-dev/lody/compare/lody-cli-v0.41.10-next.1...lody-cli-v0.41.11-next.1) (2026-04-12)

### Features

- add native OneSignal push support for mobile
  ([#1610](https://github.com/loro-dev/lody/issues/1610))
  ([ca7f08b](https://github.com/loro-dev/lody/commit/ca7f08bf0269c0745e3826a8543f070671b88d2b))
- filter lock file diffs in viewer
  ([#1649](https://github.com/loro-dev/lody/issues/1649))
  ([ebb6927](https://github.com/loro-dev/lody/commit/ebb6927e55b9542833d4ef6c082faa6f4b6615ed))
- upgrade acp
  ([513fcfd](https://github.com/loro-dev/lody/commit/513fcfdabb9f83935c170a704cfa23e545a7f7a5))

### Bug Fixes

- allow client start without required cli installs
  ([#1608](https://github.com/loro-dev/lody/issues/1608))
  ([beb184d](https://github.com/loro-dev/lody/commit/beb184d42520b4f080f4d49815642bc7d5e0e440))
- **cli:** skip auto commit after cancelled turn
  ([#1671](https://github.com/loro-dev/lody/issues/1671))
  ([6db2256](https://github.com/loro-dev/lody/commit/6db2256a80750dfae78b19f08b4224de4d0f311b))
- force official registry for codex acp
  ([#1616](https://github.com/loro-dev/lody/issues/1616))
  ([8d6a57f](https://github.com/loro-dev/lody/commit/8d6a57f4f119b244607938d48238bfeefc54cb82))
- make CLI start shutdown interruptible
  ([#1675](https://github.com/loro-dev/lody/issues/1675))
  ([ae1cc5f](https://github.com/loro-dev/lody/commit/ae1cc5ff6113400ae586865309d4e540948826b4))
- make session resource limits cgroup-aware to prevent machine lockups
  ([#1622](https://github.com/loro-dev/lody/issues/1622))
  ([3a2933c](https://github.com/loro-dev/lody/commit/3a2933c4c9304dba06078a74a44aa5ceeea13121))
- persist active session tab in URL
  ([#1625](https://github.com/loro-dev/lody/issues/1625))
  ([474f17e](https://github.com/loro-dev/lody/commit/474f17ee8cc28d8210510b0b4d0012f29a2c0a27))
- reduce cli log volume and retention
  ([#1628](https://github.com/loro-dev/lody/issues/1628))
  ([2904dcd](https://github.com/loro-dev/lody/commit/2904dcdcf0d9e19ead1f4fb1be47f135acac0aa0))
- refresh GH_TOKEN at turn start instead of turn end
  ([#1613](https://github.com/loro-dev/lody/issues/1613))
  ([423e8b9](https://github.com/loro-dev/lody/commit/423e8b9cf23d4d0eb1aa0d1a6dc719a655af42d1))
- restore gh auth fallback wrapper
  ([#1643](https://github.com/loro-dev/lody/issues/1643))
  ([45c2266](https://github.com/loro-dev/lody/commit/45c226654f5795336c9850bcb6a245bb48290ca0))
- scope injected system prompts to GitHub worktrees
  ([#1590](https://github.com/loro-dev/lody/issues/1590))
  ([5e4bf0e](https://github.com/loro-dev/lody/commit/5e4bf0e16e674cbca3a7262578f5f84cdbe81afd))
- stop persisting cli acp logs
  ([#1658](https://github.com/loro-dev/lody/issues/1658))
  ([ff25f8f](https://github.com/loro-dev/lody/commit/ff25f8fdb795f4240ae4c5f8ec7d3c304ab3d7ca))
- terminate local acp process groups
  ([#1591](https://github.com/loro-dev/lody/issues/1591))
  ([240592a](https://github.com/loro-dev/lody/commit/240592a296b36f0ca4780ff0e8036de0c4ac0188))
- throttle concurrent file diff loads and prevent layout shifts
  ([#1687](https://github.com/loro-dev/lody/issues/1687))
  ([64dd442](https://github.com/loro-dev/lody/commit/64dd442abdac0d5d414f52113e6b696fce91774b))
- use upstream Loro Streams recovery APIs
  ([#1684](https://github.com/loro-dev/lody/issues/1684))
  ([127056f](https://github.com/loro-dev/lody/commit/127056f7abc233f4e5a26ee8901b84a8126452f6))

### Performance

- batch ACP history updates
  ([#1690](https://github.com/loro-dev/lody/issues/1690))
  ([33210d7](https://github.com/loro-dev/lody/commit/33210d7f933d97732c0d358409f57015b88c1764))

### Refactors

- **cli:** prefer local gh auth over backend OAuth tokens
  ([#1582](https://github.com/loro-dev/lody/issues/1582))
  ([948c34f](https://github.com/loro-dev/lody/commit/948c34fe92b880789f0e0c2a6bffbd205d98009a))
- replace gh-shim PR interception with post-turn PR detection
  ([#1597](https://github.com/loro-dev/lody/issues/1597))
  ([a3d9990](https://github.com/loro-dev/lody/commit/a3d999043c3e2dae52a19482c37a6c60eb0d1367))

## [0.41.10-next.1](https://github.com/loro-dev/lody/compare/lody-cli-v0.41.9-next.1...lody-cli-v0.41.10-next.1) (2026-04-01)

### Features

- **cli:** add daemon mode and extract cli-supervisor package
  ([#1568](https://github.com/loro-dev/lody/issues/1568))
  ([d45af11](https://github.com/loro-dev/lody/commit/d45af11722e57b486d30a1b02829829f98343d20))
- **cli:** unify session GC with memory pressure eviction
  ([#1565](https://github.com/loro-dev/lody/issues/1565))
  ([6970429](https://github.com/loro-dev/lody/commit/6970429a1c7fc771e5b81f2ecbd63554ab927d0e))
- **components:** add session pin for context recall
  ([#1530](https://github.com/loro-dev/lody/issues/1530))
  ([e207266](https://github.com/loro-dev/lody/commit/e2072661783849b1541cac39716771d12767878c))
- **shared:** add static title generation defaults for builtin agent configs
  ([#1552](https://github.com/loro-dev/lody/issues/1552))
  ([9abf530](https://github.com/loro-dev/lody/commit/9abf5303051bb78339a7c6f84186ac3f82422435))

### Bug Fixes

- **cli:** diagnostic logging for stream_not_found room join errors
  ([#1553](https://github.com/loro-dev/lody/issues/1553))
  ([b22b9c0](https://github.com/loro-dev/lody/commit/b22b9c04ee05b5ee32c3139c067bfc50188a1650))
- **cli:** lazily join session rooms instead of eagerly connecting all on
  startup ([#1569](https://github.com/loro-dev/lody/issues/1569))
  ([1cae649](https://github.com/loro-dev/lody/commit/1cae649cf05a19cc289caa8f9d3f68702a1dbb49))
- **cli:** resolve CLI not responding to web-initiated sessions
  ([#1570](https://github.com/loro-dev/lody/issues/1570))
  ([c2308bb](https://github.com/loro-dev/lody/commit/c2308bb7b9ee42779f68bae60977df70b1b6fe3b))
- **cli:** suppress acp replay during session restore
  ([#1562](https://github.com/loro-dev/lody/issues/1562))
  ([f84e83b](https://github.com/loro-dev/lody/commit/f84e83bbc5cbdddc82259c7832ae8c1b624ff0eb))
- close acp sessions before process teardown
  ([#1554](https://github.com/loro-dev/lody/issues/1554))
  ([54bfccc](https://github.com/loro-dev/lody/commit/54bfccc0c624dc716b731b9a009c85fd5b5cdfda))

## [0.41.9-next.1](https://github.com/loro-dev/lody/compare/lody-cli-v0.41.8-next.1...lody-cli-v0.41.9-next.1) (2026-03-29)

### Features

- **cli:** support ACP loadSession for native session resume
  ([#1541](https://github.com/loro-dev/lody/issues/1541))
  ([efc4042](https://github.com/loro-dev/lody/commit/efc404209def58fea76b5b534c1cdc54e64cc118))

### Bug Fixes

- **cli:** fix process leak and aggregate per-session state
  ([#1539](https://github.com/loro-dev/lody/issues/1539))
  ([dab6e5d](https://github.com/loro-dev/lody/commit/dab6e5d3fd42e4ded60a7eba9824b693ffa8aadf))
- **cli:** fix session dispatch bugs for old and new sessions
  ([#1519](https://github.com/loro-dev/lody/issues/1519))
  ([484e956](https://github.com/loro-dev/lody/commit/484e9560ede663b29119e12199dc72eceb14d15e))
- don't terminate session on transient upstream API errors (500/529)
  ([#1538](https://github.com/loro-dev/lody/issues/1538))
  ([6d12e96](https://github.com/loro-dev/lody/commit/6d12e963af75eeddcc768289775113d5af66036b))

## [0.41.1](https://github.com/loro-dev/lody/compare/lody-cli-v0.41.0...lody-cli-v0.41.1) (2026-03-25)

### Bug Fixes

- **cli:** replace posthog-node with http client
  ([#1465](https://github.com/loro-dev/lody/issues/1465))
  ([01c48e9](https://github.com/loro-dev/lody/commit/01c48e901d848e8b7b2bd96416c904d2dc674d8e))

## [0.41.0](https://github.com/loro-dev/lody/compare/lody-cli-v0.40.0...lody-cli-v0.41.0) (2026-03-24)

### Features

- add cli session export command
  ([#1446](https://github.com/loro-dev/lody/issues/1446))
  ([642db51](https://github.com/loro-dev/lody/commit/642db5179d8b16ce2346fbfcba607a59034ca1e1))
- auto-populate title generation defaults for builtin agent configs
  ([#1452](https://github.com/loro-dev/lody/issues/1452))
  ([8da128b](https://github.com/loro-dev/lody/commit/8da128bbb3683f2f3704723f470d4862d23057ac))
- release 2026-03-24 ([#1455](https://github.com/loro-dev/lody/issues/1455))
  ([80b6f82](https://github.com/loro-dev/lody/commit/80b6f828fd539b70874acb4cbb5b946f718651df))
- support title generation for all ACP agents
  ([#1440](https://github.com/loro-dev/lody/issues/1440))
  ([9211184](https://github.com/loro-dev/lody/commit/92111846a41579d37efd669fd14050ca702657d9))

### Bug Fixes

- display specific ACP error reasons in chat failure notices
  ([80b6f82](https://github.com/loro-dev/lody/commit/80b6f828fd539b70874acb4cbb5b946f718651df))
- extract detailed error message from ACP error data.message field
  ([#1448](https://github.com/loro-dev/lody/issues/1448))
  ([680985b](https://github.com/loro-dev/lody/commit/680985b172b5b76399ad3442cb2fd92a57f0561e))
- handle empty remote repos in worktree creation
  ([#1441](https://github.com/loro-dev/lody/issues/1441))
  ([99e8805](https://github.com/loro-dev/lody/commit/99e8805f658b38850b546fb7f6e0dcf4d0845f07))
- throttle concurrent file operations in code session to prevent CPU blocking
  ([#1442](https://github.com/loro-dev/lody/issues/1442))
  ([51aafb3](https://github.com/loro-dev/lody/commit/51aafb3ffee70fabf03126ca9ed345a951e57265))

### Refactors

- remove AgentClient yolo/modes/models/commands fields, use legacy
  setSessionMode for codex
  ([#1450](https://github.com/loro-dev/lody/issues/1450))
  ([f97131b](https://github.com/loro-dev/lody/commit/f97131b43753b76dd204107034fcb1ad9055ab91))

## [0.40.0](https://github.com/loro-dev/lody/compare/lody-cli-v0.39.0...lody-cli-v0.40.0) (2026-03-21)

### Features

- expand posthog instrumentation
  ([#1397](https://github.com/loro-dev/lody/issues/1397))
  ([9a65bff](https://github.com/loro-dev/lody/commit/9a65bff9af96232986c6de523830e8ef5b1be425))

### Bug Fixes

- acp unsupport config option
  ([#1426](https://github.com/loro-dev/lody/issues/1426))
  ([96a0695](https://github.com/loro-dev/lody/commit/96a06956950b9dcb17e34fd1fb5065cea49d95ee))
- add backward compatibility fallback for setSessionConfigOption
  ([#1424](https://github.com/loro-dev/lody/issues/1424))
  ([7f45585](https://github.com/loro-dev/lody/commit/7f45585702a07ab98885bf1c98d15820be81fb23))

## [0.40.2-next.1](https://github.com/loro-dev/lody/compare/lody-cli-v0.40.1-next.1...lody-cli-v0.40.2-next.1) (2026-03-21)

### Features

- expand posthog instrumentation
  ([#1397](https://github.com/loro-dev/lody/issues/1397))
  ([9a65bff](https://github.com/loro-dev/lody/commit/9a65bff9af96232986c6de523830e8ef5b1be425))

### Bug Fixes

- add backward compatibility fallback for setSessionConfigOption
  ([#1424](https://github.com/loro-dev/lody/issues/1424))
  ([7f45585](https://github.com/loro-dev/lody/commit/7f45585702a07ab98885bf1c98d15820be81fb23))

## [0.40.1-next.1](https://github.com/loro-dev/lody/compare/lody-cli-v0.40.0-next.1...lody-cli-v0.40.1-next.1) (2026-03-20)

### ⚠ BREAKING CHANGES

- isolate usage delta baselines by acpSessionId
  ([#1274](https://github.com/loro-dev/lody/issues/1274))

### Features

- add agent configuration options for CLI type and agent type
  ([#1310](https://github.com/loro-dev/lody/issues/1310))
  ([aca796f](https://github.com/loro-dev/lody/commit/aca796fc617f5644f3c87413a67ded879214c93b))
- add assistant image upload flow
  ([#1307](https://github.com/loro-dev/lody/issues/1307))
  ([b7d904f](https://github.com/loro-dev/lody/commit/b7d904f67069b5ce407aceae6c273deb1c5a674c))
- add branch-aware session startup
  ([#1102](https://github.com/loro-dev/lody/issues/1102))
  ([bac1b50](https://github.com/loro-dev/lody/commit/bac1b5076ac3678f997427dff472691ebd003585))
- add built-in opencode ACP support
  ([#1221](https://github.com/loro-dev/lody/issues/1221))
  ([4e8b644](https://github.com/loro-dev/lody/commit/4e8b6447d9264f20e0ff354cc1bd0bedaddc6c60))
- add electron CLI runtime state channel and sidebar status
  ([#1210](https://github.com/loro-dev/lody/issues/1210))
  ([071cbaa](https://github.com/loro-dev/lody/commit/071cbaa26af4113a7f2f62d20b8c6a2af2abfbaa))
- add electron local-first session control path
  ([#1169](https://github.com/loro-dev/lody/issues/1169))
  ([41d5e96](https://github.com/loro-dev/lody/commit/41d5e961bcb0d9258326da7c0cb2c362a2ffcddb))
- add local CLI probe, shared worktree paths, and Open in VS Code button
  ([#1017](https://github.com/loro-dev/lody/issues/1017))
  ([8cb32e4](https://github.com/loro-dev/lody/commit/8cb32e47ff65002f060d146aceacc02630b1747d))
- add session image chat input and ACP image blocks
  ([#1207](https://github.com/loro-dev/lody/issues/1207))
  ([e31f2b6](https://github.com/loro-dev/lody/commit/e31f2b645e0d444f35317e4dc06b0d9d42f5c78a))
- all CLI command ([#1320](https://github.com/loro-dev/lody/issues/1320))
  ([49428dd](https://github.com/loro-dev/lody/commit/49428dd688394da2a10bde1c0679c3f513f887f5))
- **auth:** user-scoped CLI token + multi-workspace support
  ([#1048](https://github.com/loro-dev/lody/issues/1048))
  ([1da6f20](https://github.com/loro-dev/lody/commit/1da6f20dd6c2e25116da0973814b59a1c77dfc9d))
- basic electron ([#1015](https://github.com/loro-dev/lody/issues/1015))
  ([3019fc9](https://github.com/loro-dev/lody/commit/3019fc91ced6e8cbe1f03124bb10e6238e9a1bb4))
- bootstrap Electron CLI auth from session token
  ([#1148](https://github.com/loro-dev/lody/issues/1148))
  ([77b2bfa](https://github.com/loro-dev/lody/commit/77b2bfaf7bdef4d107bfc900773769c5ff2664ec))
- chat mentions ([#1028](https://github.com/loro-dev/lody/issues/1028))
  ([62d53c6](https://github.com/loro-dev/lody/commit/62d53c6845cd94aa8c491557b04a315ac9219a1c))
- **cli:** add ACP idle timer to auto-shutdown inactive sessions after 3 hours
  ([#1009](https://github.com/loro-dev/lody/issues/1009))
  ([293c2b3](https://github.com/loro-dev/lody/commit/293c2b30d30fb291d0a7b9d045744475ea7920c6))
- **cli:** add Linux execution cgroup limits
  ([#1295](https://github.com/loro-dev/lody/issues/1295))
  ([ac63f1c](https://github.com/loro-dev/lody/commit/ac63f1ccdb0d82900515786eb39edc51cf5600a8))
- **cli:** archive worktrees with backup commits
  ([#1314](https://github.com/loro-dev/lody/issues/1314))
  ([2247966](https://github.com/loro-dev/lody/commit/22479667000e40cdd55346abcf762bdb781444d8))
- **cli:** implement transparent gh shim for PR workflows
  ([#1163](https://github.com/loro-dev/lody/issues/1163))
  ([d675614](https://github.com/loro-dev/lody/commit/d675614a987970262ab6c00be98b199d640b9b20))
- **cli:** load environment variables based on runtime environment
  ([758d310](https://github.com/loro-dev/lody/commit/758d310e01d6ab93bccddcaee5bccfb4fdb15010))
- **cli:** simplify start defaults and remove prompts
  ([#1117](https://github.com/loro-dev/lody/issues/1117))
  ([bb09e1c](https://github.com/loro-dev/lody/commit/bb09e1ced390f2faa4fd668cd29fb7bdee8edaa5))
- **cli:** use jiti for dev startup instead of bun
  ([#1297](https://github.com/loro-dev/lody/issues/1297))
  ([f6023bf](https://github.com/loro-dev/lody/commit/f6023bf2b092786671855ffdf1f5691134b8e4d1))
- **components:** add context window usage progress bar to session header
  ([#975](https://github.com/loro-dev/lody/issues/975))
  ([5bee209](https://github.com/loro-dev/lody/commit/5bee20905898449565bd6d5baf41b68eb39c44d9))
- **components:** implement archive sessions view
  ([#983](https://github.com/loro-dev/lody/issues/983))
  ([d5fc814](https://github.com/loro-dev/lody/commit/d5fc81412723141239fe437501838f15e50a24c2))
- electron deeplink Auth ([#1142](https://github.com/loro-dev/lody/issues/1142))
  ([36bb712](https://github.com/loro-dev/lody/commit/36bb712df401988280fcd8e908a41f20acb46f3a))
- electron start cli ([#1047](https://github.com/loro-dev/lody/issues/1047))
  ([aed10db](https://github.com/loro-dev/lody/commit/aed10dbd8f25f7d6d9935483b48cbd03257822f2))
- **electron:** add desktop notification toggle with system settings guidance
  ([#1110](https://github.com/loro-dev/lody/issues/1110))
  ([293dc74](https://github.com/loro-dev/lody/commit/293dc74d555d83cda4640c5e37e03350d5613ecd))
- **electron:** local projects
  ([#1060](https://github.com/loro-dev/lody/issues/1060))
  ([166bffe](https://github.com/loro-dev/lody/commit/166bffe8ec03758a82c7a8e49c9ab423b6c5f239))
- enable GitHub capabilities for linked local projects
  ([#1170](https://github.com/loro-dev/lody/issues/1170))
  ([a9b5d87](https://github.com/loro-dev/lody/commit/a9b5d87b71c3894037e2f2e8767155bcaab980d0))
- gpt-5.4
  ([91f0afc](https://github.com/loro-dev/lody/commit/91f0afc920d9623696efdf332012d08baeaa8320))
- gpt-5.4 & fix codex tokens
  ([4730e92](https://github.com/loro-dev/lody/commit/4730e92021b388d2a87fc0767266569c0f540497))
- include issue/PR mentions in ACP prompt
  ([#1080](https://github.com/loro-dev/lody/issues/1080))
  ([f379fa9](https://github.com/loro-dev/lody/commit/f379fa90aac34d70843d1dc4ec96c810a2c97d57))
- machine quota ([#973](https://github.com/loro-dev/lody/issues/973))
  ([28b21ce](https://github.com/loro-dev/lody/commit/28b21cef3e99292da312c9137c9572e399c15398))
- make builtin agent config options dynamic
  ([#1413](https://github.com/loro-dev/lody/issues/1413))
  ([e2b95ef](https://github.com/loro-dev/lody/commit/e2b95efd5f7d75ffcc22532491a41ef0ae78724f))
- migrate builtin agents to unified setSessionConfigOption API
  ([#1407](https://github.com/loro-dev/lody/issues/1407))
  ([ff2c79b](https://github.com/loro-dev/lody/commit/ff2c79b0712a9b79d04da3a2d7facad39f4b9e72))
- move local project implementation to CLI daemon
  ([#1192](https://github.com/loro-dev/lody/issues/1192))
  ([508b8c0](https://github.com/loro-dev/lody/commit/508b8c0adb0a5d2fb9b6ab3fd71343e3708ab6b7))
- new acp, context window
  ([#1273](https://github.com/loro-dev/lody/issues/1273))
  ([a523942](https://github.com/loro-dev/lody/commit/a523942cc5271503f8cc373b3ea12017084c457c))
- persist availableCommands from ACP available_commands_update
  ([#1414](https://github.com/loro-dev/lody/issues/1414))
  ([7bb3ba2](https://github.com/loro-dev/lody/commit/7bb3ba22d31c00d6bfbfb110978644e9afe0d37a))
- prevent system sleep while sessions are running
  ([#1357](https://github.com/loro-dev/lody/issues/1357))
  ([2c87b9d](https://github.com/loro-dev/lody/commit/2c87b9d8758bd995295df84b20ff10904614251d))
- release 2026-02-06
  ([3872d71](https://github.com/loro-dev/lody/commit/3872d7117283eb3b10ff4553e005604ee0a037b2))
- release 2026-03-18 ([#1389](https://github.com/loro-dev/lody/issues/1389))
  ([0aec1e5](https://github.com/loro-dev/lody/commit/0aec1e5de84886bc1d935243fdca5f9fbd5829a3))
- release 2026-03-19
  ([8796e6e](https://github.com/loro-dev/lody/commit/8796e6e17cfa8b6ffc90986598b46c059d97ac09))
- release 2026-03-20 ([#1421](https://github.com/loro-dev/lody/issues/1421))
  ([0f17bb9](https://github.com/loro-dev/lody/commit/0f17bb934e53be702a5cbf286e30d35052ef8af7))
- release 2026-0312 ([#1331](https://github.com/loro-dev/lody/issues/1331))
  ([9a90d61](https://github.com/loro-dev/lody/commit/9a90d612bb5b405e3f5072f377b8615667ee65d3))
- release 2026-0317 ([#1372](https://github.com/loro-dev/lody/issues/1372))
  ([d3d7812](https://github.com/loro-dev/lody/commit/d3d7812d577271cb8636306b2dbd7dc1788d0340))
- release please
  ([6c363e8](https://github.com/loro-dev/lody/commit/6c363e8acd477ea0cfc65e81adf95d7bb67f3337))
- remove local project path mapping and persist absolute paths
  ([#1240](https://github.com/loro-dev/lody/issues/1240))
  ([5c991f8](https://github.com/loro-dev/lody/commit/5c991f89b2a8d7d46eba7c4f84e1edd70ea0b92b))
- show counts for collapsed sidebar groups
  ([9a90d61](https://github.com/loro-dev/lody/commit/9a90d612bb5b405e3f5072f377b8615667ee65d3))
- support ACP session config options
  ([#1308](https://github.com/loro-dev/lody/issues/1308))
  ([3148e20](https://github.com/loro-dev/lody/commit/3148e201c0d9f360cc8001a96153ce92c20d730e))
- upgrade acp ([#1081](https://github.com/loro-dev/lody/issues/1081))
  ([0343089](https://github.com/loro-dev/lody/commit/03430895993d8b2403845b0e88b03837e11a37cb))
- upgrade acp ([#1366](https://github.com/loro-dev/lody/issues/1366))
  ([2fafde1](https://github.com/loro-dev/lody/commit/2fafde15cbe2408f9d5f92e2d3123dbff46c51c9))
- upgrade claude acp
  ([21b75a0](https://github.com/loro-dev/lody/commit/21b75a07ac006bc204fadf0ea2015d273f04db53))
- wire feedback post id into session start
  ([#1333](https://github.com/loro-dev/lody/issues/1333))
  ([70c9b46](https://github.com/loro-dev/lody/commit/70c9b46fd1975927274753a7b6a6a77085da399a))

### Bug Fixes

- fix:
  ([16347e9](https://github.com/loro-dev/lody/commit/16347e90f451d251ced080b32ff4a4130edded8a))
- fix:
  ([2180c11](https://github.com/loro-dev/lody/commit/2180c111ed889080ff651d1c47e83c68c5da251b))
- **acp:** fix terminal command/output extraction for Claude Code v0.19+
  ([#1294](https://github.com/loro-dev/lody/issues/1294))
  ([373e6d4](https://github.com/loro-dev/lody/commit/373e6d41d547afe1e4122c268b6effcf81cbc49f))
- add missing i18n translations
  ([#976](https://github.com/loro-dev/lody/issues/976))
  ([85cc071](https://github.com/loro-dev/lody/commit/85cc07104c95c131978a6f4e808e169591641b35))
- await pending usage update handlers before flushing to prevent race
  ([#1267](https://github.com/loro-dev/lody/issues/1267))
  ([d257015](https://github.com/loro-dev/lody/commit/d257015e5ab88b39d00fd1416757cbfecfe59d25))
- bump selector font size and normalize codex spark labels
  ([#1176](https://github.com/loro-dev/lody/issues/1176))
  ([71bda6b](https://github.com/loro-dev/lody/commit/71bda6bc06cb5b77e3108e06d0b363e803e469b6))
- ci
  ([7dc67ee](https://github.com/loro-dev/lody/commit/7dc67eed2b4a6af62707e1f5def78ed97306cf2e))
- ci build ([#1199](https://github.com/loro-dev/lody/issues/1199))
  ([1074ad3](https://github.com/loro-dev/lody/commit/1074ad32867cc27e23c48ba9f050f4031926cc1d))
- claude acp
  ([0e3f062](https://github.com/loro-dev/lody/commit/0e3f062010f28d5ad05bd884593e7526589ed9b2))
- cli auth url
  ([27e052c](https://github.com/loro-dev/lody/commit/27e052c48aa599db8833f174b58a9571a26609bc))
- cli auth url
  ([89d5a37](https://github.com/loro-dev/lody/commit/89d5a37832cb4587c5d75e0f8560d642aa780d16))
- cli release please
  ([874903c](https://github.com/loro-dev/lody/commit/874903c8bd2c74c0f953a08a7f083bce259a0aec))
- **cli:** accumulate buffers before decoding to handle split multi-byte chars
  ([945edfe](https://github.com/loro-dev/lody/commit/945edfece547772ceea3d38476104a335fa6119f))
- **cli:** add user to /etc/passwd when running container with host UID
  ([#1002](https://github.com/loro-dev/lody/issues/1002))
  ([71354b8](https://github.com/loro-dev/lody/commit/71354b83795bef23327a670ed552f9e5572e2173))
- **cli:** always enforce minimum 6GB memory per container
  ([#1038](https://github.com/loro-dev/lody/issues/1038))
  ([c3d4194](https://github.com/loro-dev/lody/commit/c3d41947e795e044a443a54a73b3ea77e6ff7a5a))
- **cli:** cleanup failed Loro init to prevent listener leaks
  ([#1143](https://github.com/loro-dev/lody/issues/1143))
  ([2f876e5](https://github.com/loro-dev/lody/commit/2f876e5240e780f09e8b97d4a25b1dd84181fb86))
- **cli:** handle Windows code page encoding for terminal output
  ([6db63a3](https://github.com/loro-dev/lody/commit/6db63a37832f50d26d109559b8ed98021f5d2810))
- **cli:** harden ACP startup against invalid installs
  ([#1306](https://github.com/loro-dev/lody/issues/1306))
  ([7aea665](https://github.com/loro-dev/lody/commit/7aea6656d0d5d1fba709e74c12bf0385089245b8))
- **cli:** inject agent config env on resume
  ([#1071](https://github.com/loro-dev/lody/issues/1071))
  ([c4e203f](https://github.com/loro-dev/lody/commit/c4e203ff56c3f32077f5056ce87d8067325abf2d))
- **cli:** normalize SITE_APP_BASE_PATH for device verification URL
  ([ba22d77](https://github.com/loro-dev/lody/commit/ba22d77a2088828dc60c21c3b137ccf4faf6d1da))
- **cli:** precheck existing start process before login
  ([#1156](https://github.com/loro-dev/lody/issues/1156))
  ([16f16ba](https://github.com/loro-dev/lody/commit/16f16baf0d390923d6c811c83b10fdc35f9f896d))
- **cli:** preserve local projects on machine re-register
  ([#1120](https://github.com/loro-dev/lody/issues/1120))
  ([c969675](https://github.com/loro-dev/lody/commit/c9696757574e80a8ae1c147ddd372d1c314499e7))
- **cli:** preserve raceLimits when re-registering machine
  ([#996](https://github.com/loro-dev/lody/issues/996))
  ([ed2518e](https://github.com/loro-dev/lody/commit/ed2518e05a32b476428cd85087fee77567a25155))
- **cli:** prevent container reuse across different home directories
  ([29fe79b](https://github.com/loro-dev/lody/commit/29fe79bef6bd76575212fd8824ba08aa68dd3ffd))
- **cli:** prevent silent exit in bundled build
  ([#1070](https://github.com/loro-dev/lody/issues/1070))
  ([66a467d](https://github.com/loro-dev/lody/commit/66a467dd9e6a9a0f3e33de91dc029af23549a410))
- **cli:** reduce noisy prompt pending warnings
  ([#1033](https://github.com/loro-dev/lody/issues/1033))
  ([651b3e9](https://github.com/loro-dev/lody/commit/651b3e95a630f4321d6717210d51e8872af4dc34))
- **cli:** remove debug log that breaks bash tool due to BigInt serialization
  ([#1006](https://github.com/loro-dev/lody/issues/1006))
  ([6714657](https://github.com/loro-dev/lody/commit/671465735e31e498d0c26039fc3fd5bf48998cc3))
- **cli:** remove TypeScript syntax from .cjs wrapper source
  ([#997](https://github.com/loro-dev/lody/issues/997))
  ([55c27d2](https://github.com/loro-dev/lody/commit/55c27d23811af8161851da414619a01dafeaee1a))
- **cli:** require only one local agent CLI by default
  ([#1222](https://github.com/loro-dev/lody/issues/1222))
  ([1766dfd](https://github.com/loro-dev/lody/commit/1766dfdf7d58b852dd3f1fa022639a14dc285dd8))
- **cli:** require only one local agent CLI by default
  ([#1222](https://github.com/loro-dev/lody/issues/1222))
  ([a6157c1](https://github.com/loro-dev/lody/commit/a6157c199a175dc5188530c6eae495be5aa4458f))
- **cli:** resolve Windows spawn ENOENT errors
  ([#985](https://github.com/loro-dev/lody/issues/985))
  ([9a639aa](https://github.com/loro-dev/lody/commit/9a639aa2c3ed838604f8adb57c0c4d2d77779351))
- **cli:** resolve Windows spawn ENOENT errors
  ([#985](https://github.com/loro-dev/lody/issues/985))
  ([321f7fd](https://github.com/loro-dev/lody/commit/321f7fda2b7df54e2bfcb547c0017202b80f3cb2))
- **cli:** run fleet.shutdown() on uncaught exceptions to release ports
  ([#1391](https://github.com/loro-dev/lody/issues/1391))
  ([f5cf3ef](https://github.com/loro-dev/lody/commit/f5cf3ef68c0236219bfb5f4f18e400ea47f952fd))
- **cli:** set turnId before applyAcpModeAndModel to prevent ACP flush error
  ([#1418](https://github.com/loro-dev/lody/issues/1418))
  ([eee7524](https://github.com/loro-dev/lody/commit/eee752465314afb34f4596dc9d5b320ed4597081))
- **cli:** show detailed ACP error messages in Web UI
  ([#1024](https://github.com/loro-dev/lody/issues/1024))
  ([6c00a90](https://github.com/loro-dev/lody/commit/6c00a90f34ef278da1daf957f8e29aaadbf718f5))
- **cli:** simplify workspace dirty check to only detect uncommitted changes
  ([#1292](https://github.com/loro-dev/lody/issues/1292))
  ([bb0662f](https://github.com/loro-dev/lody/commit/bb0662f8d102445f3eee615fdbae1edbe0a10b63))
- **cli:** use session base branch for diff stats
  ([#1238](https://github.com/loro-dev/lody/issues/1238))
  ([d9ba0a4](https://github.com/loro-dev/lody/commit/d9ba0a4cecda6e28243e283e5afb65b1c8ffe6bd))
- codex quota limit ([#1276](https://github.com/loro-dev/lody/issues/1276))
  ([e2e0d63](https://github.com/loro-dev/lody/commit/e2e0d632c4a753316aac8760bbd3dda37df93dd2))
- context window & usage calc
  ([#1067](https://github.com/loro-dev/lody/issues/1067))
  ([3625a6e](https://github.com/loro-dev/lody/commit/3625a6e56680b8914d3e3a4d9cb1eb56ed43fba7))
- csc name
  ([9a90d61](https://github.com/loro-dev/lody/commit/9a90d612bb5b405e3f5072f377b8615667ee65d3))
- csc name
  ([3e1535c](https://github.com/loro-dev/lody/commit/3e1535c9146529be1bc2dcb07f9a6fccd3af9089))
- distinguish duplicated codex rate limits in settings
  ([#1258](https://github.com/loro-dev/lody/issues/1258))
  ([97fc675](https://github.com/loro-dev/lody/commit/97fc675398b621ef4070fdbf63d6ecb96781fc9c))
- gh wrapper
  ([cc89334](https://github.com/loro-dev/lody/commit/cc89334ccefe44a267399dd97db41e5fad65ebf7))
- gh wrapper
  ([3fb7f5b](https://github.com/loro-dev/lody/commit/3fb7f5beac7faec48ddff2d876b42377b350c08d))
- gpt-5.3 price
  ([e6e4cfe](https://github.com/loro-dev/lody/commit/e6e4cfe1dde1b6d642e1bd8a2c48fe2b7fb8e923))
- gpt-5.3 price
  ([797a1fb](https://github.com/loro-dev/lody/commit/797a1fb0f65329274b9309ebe34da871f5036440))
- linux electron build
  ([aa08f79](https://github.com/loro-dev/lody/commit/aa08f7968aee8a408c2c3b8ef1eab2f76f414539))
- preserve plan expand/collapse state across virtual scroll unmount
  ([#1261](https://github.com/loro-dev/lody/issues/1261))
  ([c78146d](https://github.com/loro-dev/lody/commit/c78146d53127658ccd348a60e630586c5ca5845f))
- preview
  ([01b7bab](https://github.com/loro-dev/lody/commit/01b7bab635a69d3d608e13f9bbeecd5c4da8e83e))
- prompt
  ([84741f5](https://github.com/loro-dev/lody/commit/84741f5ef273e3e379e66f9b2ccd994aa999b3ab))
- prompt
  ([ed9c849](https://github.com/loro-dev/lody/commit/ed9c849a9a5e05dc1d60ea646176429cdd3d9673))
- recover stale local CLI servers on startup
  ([39995b7](https://github.com/loro-dev/lody/commit/39995b7dc7c79cfd737fbcf760fbcb5cae3ace23))
- reduce control ping keepalive interval to 10s
  ([#1214](https://github.com/loro-dev/lody/issues/1214))
  ([76de5e8](https://github.com/loro-dev/lody/commit/76de5e888275cd3c3358b4ede19938218d0c8a69))
- remove non-git local project import notice
  ([#1337](https://github.com/loro-dev/lody/issues/1337))
  ([03f2e5a](https://github.com/loro-dev/lody/commit/03f2e5a3d5172696d18ab39121ff86f5028dd8ce))
- rename claude bin ([#955](https://github.com/loro-dev/lody/issues/955))
  ([7375d2f](https://github.com/loro-dev/lody/commit/7375d2ff9ee1b07ca59aa979f438cb428b6ffa6d))
- report usage at turn end and align codex snapshot semantics
  ([#1257](https://github.com/loro-dev/lody/issues/1257))
  ([1fa8aa5](https://github.com/loro-dev/lody/commit/1fa8aa5df483e930b3b8f32f8b3709be25a244a2))
- restore repo list scrolling in integrations settings
  ([#1352](https://github.com/loro-dev/lody/issues/1352))
  ([581219b](https://github.com/loro-dev/lody/commit/581219bbb7b858df9cd96c1e2585a9beecd1c1a2))
- restore user's permission level after agent exits plan mode
  ([#1270](https://github.com/loro-dev/lody/issues/1270))
  ([d065647](https://github.com/loro-dev/lody/commit/d0656473d4b832f2d793097280fcd33d207a7e29))
- stabilize loro-repo sync migration and flock-wasm bundler checks
  ([#1129](https://github.com/loro-dev/lody/issues/1129))
  ([aabe3ea](https://github.com/loro-dev/lody/commit/aabe3ea14d795d1b0a9f81ae527ba339adac2026))
- stop persisting available commands in history
  ([#1419](https://github.com/loro-dev/lody/issues/1419))
  ([0dfca6a](https://github.com/loro-dev/lody/commit/0dfca6a91798853238e2e10f7cbb0f83924f89fc))
- test ([#1201](https://github.com/loro-dev/lody/issues/1201))
  ([9d30440](https://github.com/loro-dev/lody/commit/9d3044079353f5251eaa1f0d5b7f0181e46929ef))
- tighten cli shutdown cleanup for local services
  ([#1220](https://github.com/loro-dev/lody/issues/1220))
  ([9f57c8e](https://github.com/loro-dev/lody/commit/9f57c8e07f8c9d7cf8249334a344af63055f69c1))
- trigger cli release
  ([2b81437](https://github.com/loro-dev/lody/commit/2b8143742eba37fb0bb3f445e1e0406d57b6c0b7))
- update cc acp
  ([caa318f](https://github.com/loro-dev/lody/commit/caa318f285091adf7054ff87fcf8efbd675dc430))
- use betterAuthClient for AuthClient auth validation
  ([#1161](https://github.com/loro-dev/lody/issues/1161))
  ([a83097a](https://github.com/loro-dev/lody/commit/a83097a61777ee5bf797cda1a7c527fa5ddce54b))
- windows deeplink callback and spawn shell options
  ([#1224](https://github.com/loro-dev/lody/issues/1224))
  ([22b03e8](https://github.com/loro-dev/lody/commit/22b03e831912bc4cfe12b72ed2eff045dd507902))
- z.ai
  ([6337f8a](https://github.com/loro-dev/lody/commit/6337f8a48cd1a2ef98b44e7d45f00f774cef0a45))

### Performance

- **cli:** avoid unnecessary recursive chown on container start
  ([#977](https://github.com/loro-dev/lody/issues/977))
  ([d4ffea5](https://github.com/loro-dev/lody/commit/d4ffea554310789a815931ce0edea4ed1ff097a1))
- **cli:** reduce npx install size by removing bundled deps and sourcemaps
  ([#1136](https://github.com/loro-dev/lody/issues/1136))
  ([ce053c5](https://github.com/loro-dev/lody/commit/ce053c50a1e0e3446b09cb8a6730091d3a1ddf17))

### Refactors

- **cli:** native-only runtime, remove docker/background modes
  ([#1160](https://github.com/loro-dev/lody/issues/1160))
  ([e5a475d](https://github.com/loro-dev/lody/commit/e5a475de53f959f5f2ec7e16f6242bf4c48788fa))
- isolate usage delta baselines by acpSessionId
  ([#1274](https://github.com/loro-dev/lody/issues/1274))
  ([5d35939](https://github.com/loro-dev/lody/commit/5d359399ee073651b9a417c6b543adb897b8ce2f))
- move image upload from CLI command to local server endpoint
  ([#1354](https://github.com/loro-dev/lody/issues/1354))
  ([85087e6](https://github.com/loro-dev/lody/commit/85087e6cc350347ddd0f136efa2eb3e78fcaff8a))

### Documentation

- unified New Session landing page design
  ([#1259](https://github.com/loro-dev/lody/issues/1259))
  ([6884bfa](https://github.com/loro-dev/lody/commit/6884bfa61dab50e33bcbb182f38cf25a17b9cb22))

## [0.39.0](https://github.com/loro-dev/lody/compare/lody-cli-v0.38.0...lody-cli-v0.39.0) (2026-03-20)

### Features

- make builtin agent config options dynamic
  ([#1413](https://github.com/loro-dev/lody/issues/1413))
  ([e2b95ef](https://github.com/loro-dev/lody/commit/e2b95efd5f7d75ffcc22532491a41ef0ae78724f))
- migrate builtin agents to unified setSessionConfigOption API
  ([#1407](https://github.com/loro-dev/lody/issues/1407))
  ([ff2c79b](https://github.com/loro-dev/lody/commit/ff2c79b0712a9b79d04da3a2d7facad39f4b9e72))
- persist availableCommands from ACP available_commands_update
  ([#1414](https://github.com/loro-dev/lody/issues/1414))
  ([7bb3ba2](https://github.com/loro-dev/lody/commit/7bb3ba22d31c00d6bfbfb110978644e9afe0d37a))
- release 2026-03-20 ([#1421](https://github.com/loro-dev/lody/issues/1421))
  ([0f17bb9](https://github.com/loro-dev/lody/commit/0f17bb934e53be702a5cbf286e30d35052ef8af7))

### Bug Fixes

- **cli:** set turnId before applyAcpModeAndModel to prevent ACP flush error
  ([#1418](https://github.com/loro-dev/lody/issues/1418))
  ([eee7524](https://github.com/loro-dev/lody/commit/eee752465314afb34f4596dc9d5b320ed4597081))
- prompt
  ([84741f5](https://github.com/loro-dev/lody/commit/84741f5ef273e3e379e66f9b2ccd994aa999b3ab))
- stop persisting available commands in history
  ([#1419](https://github.com/loro-dev/lody/issues/1419))
  ([0dfca6a](https://github.com/loro-dev/lody/commit/0dfca6a91798853238e2e10f7cbb0f83924f89fc))

## [0.38.0](https://github.com/loro-dev/lody/compare/lody-cli-v0.37.2...lody-cli-v0.38.0) (2026-03-19)

### Features

- release 2026-03-19
  ([8796e6e](https://github.com/loro-dev/lody/commit/8796e6e17cfa8b6ffc90986598b46c059d97ac09))

### Bug Fixes

- recover stale local CLI servers on startup
  ([39995b7](https://github.com/loro-dev/lody/commit/39995b7dc7c79cfd737fbcf760fbcb5cae3ace23))

## [0.37.2](https://github.com/loro-dev/lody/compare/lody-cli-v0.37.1...lody-cli-v0.37.2) (2026-03-19)

### Chores

- **lody-cli:** Synchronize lody-cli-electron versions

## [0.37.1](https://github.com/loro-dev/lody/compare/lody-cli-v0.37.0...lody-cli-v0.37.1) (2026-03-18)

### Chores

- **lody-cli:** Synchronize lody-cli-electron versions

## [0.37.0](https://github.com/loro-dev/lody/compare/lody-cli-v0.36.0...lody-cli-v0.37.0) (2026-03-18)

### Features

- release 2026-03-18 ([#1389](https://github.com/loro-dev/lody/issues/1389))
  ([0aec1e5](https://github.com/loro-dev/lody/commit/0aec1e5de84886bc1d935243fdca5f9fbd5829a3))

### Bug Fixes

- cli release please
  ([874903c](https://github.com/loro-dev/lody/commit/874903c8bd2c74c0f953a08a7f083bce259a0aec))
- **cli:** run fleet.shutdown() on uncaught exceptions to release ports
  ([#1391](https://github.com/loro-dev/lody/issues/1391))
  ([f5cf3ef](https://github.com/loro-dev/lody/commit/f5cf3ef68c0236219bfb5f4f18e400ea47f952fd))

## [0.36.0](https://github.com/loro-dev/lody/compare/lody-cli-v0.35.0...lody-cli-v0.36.0) (2026-03-17)

### Features

- release 2026-0317 ([#1372](https://github.com/loro-dev/lody/issues/1372))
  ([d3d7812](https://github.com/loro-dev/lody/commit/d3d7812d577271cb8636306b2dbd7dc1788d0340))

## [0.35.0](https://github.com/loro-dev/lody/compare/lody-cli-v0.34.0...lody-cli-v0.35.0) (2026-03-12)

### Features

- add agent configuration options for CLI type and agent type
  ([#1310](https://github.com/loro-dev/lody/issues/1310))
  ([aca796f](https://github.com/loro-dev/lody/commit/aca796fc617f5644f3c87413a67ded879214c93b))
- add assistant image upload flow
  ([#1307](https://github.com/loro-dev/lody/issues/1307))
  ([b7d904f](https://github.com/loro-dev/lody/commit/b7d904f67069b5ce407aceae6c273deb1c5a674c))
- **cli:** archive worktrees with backup commits
  ([#1314](https://github.com/loro-dev/lody/issues/1314))
  ([2247966](https://github.com/loro-dev/lody/commit/22479667000e40cdd55346abcf762bdb781444d8))
- **cli:** use jiti for dev startup instead of bun
  ([#1297](https://github.com/loro-dev/lody/issues/1297))
  ([f6023bf](https://github.com/loro-dev/lody/commit/f6023bf2b092786671855ffdf1f5691134b8e4d1))
- release 2026-0312 ([#1331](https://github.com/loro-dev/lody/issues/1331))
  ([9a90d61](https://github.com/loro-dev/lody/commit/9a90d612bb5b405e3f5072f377b8615667ee65d3))
- show counts for collapsed sidebar groups
  ([9a90d61](https://github.com/loro-dev/lody/commit/9a90d612bb5b405e3f5072f377b8615667ee65d3))
- support ACP session config options
  ([#1308](https://github.com/loro-dev/lody/issues/1308))
  ([3148e20](https://github.com/loro-dev/lody/commit/3148e201c0d9f360cc8001a96153ce92c20d730e))

### Bug Fixes

- **acp:** fix terminal command/output extraction for Claude Code v0.19+
  ([#1294](https://github.com/loro-dev/lody/issues/1294))
  ([373e6d4](https://github.com/loro-dev/lody/commit/373e6d41d547afe1e4122c268b6effcf81cbc49f))
- **cli:** harden ACP startup against invalid installs
  ([#1306](https://github.com/loro-dev/lody/issues/1306))
  ([7aea665](https://github.com/loro-dev/lody/commit/7aea6656d0d5d1fba709e74c12bf0385089245b8))
- csc name
  ([9a90d61](https://github.com/loro-dev/lody/commit/9a90d612bb5b405e3f5072f377b8615667ee65d3))
- csc name
  ([3e1535c](https://github.com/loro-dev/lody/commit/3e1535c9146529be1bc2dcb07f9a6fccd3af9089))
- preview
  ([01b7bab](https://github.com/loro-dev/lody/commit/01b7bab635a69d3d608e13f9bbeecd5c4da8e83e))
- prompt
  ([ed9c849](https://github.com/loro-dev/lody/commit/ed9c849a9a5e05dc1d60ea646176429cdd3d9673))

## [0.34.0](https://github.com/loro-dev/lody/compare/lody-cli-v0.33.1...lody-cli-v0.34.0) (2026-03-06)

### Features

- **cli:** add Linux execution cgroup limits
  ([#1295](https://github.com/loro-dev/lody/issues/1295))
  ([ac63f1c](https://github.com/loro-dev/lody/commit/ac63f1ccdb0d82900515786eb39edc51cf5600a8))
- gpt-5.4
  ([91f0afc](https://github.com/loro-dev/lody/commit/91f0afc920d9623696efdf332012d08baeaa8320))
- gpt-5.4 & fix codex tokens
  ([4730e92](https://github.com/loro-dev/lody/commit/4730e92021b388d2a87fc0767266569c0f540497))

### Bug Fixes

- **cli:** simplify workspace dirty check to only detect uncommitted changes
  ([#1292](https://github.com/loro-dev/lody/issues/1292))
  ([bb0662f](https://github.com/loro-dev/lody/commit/bb0662f8d102445f3eee615fdbae1edbe0a10b63))

## [0.33.1](https://github.com/loro-dev/lody/compare/lody-cli-v0.33.0...lody-cli-v0.33.1) (2026-03-05)

### Bug Fixes

- ci
  ([7dc67ee](https://github.com/loro-dev/lody/commit/7dc67eed2b4a6af62707e1f5def78ed97306cf2e))

## [0.33.0](https://github.com/loro-dev/lody/compare/lody-cli-v0.32.5...lody-cli-v0.33.0) (2026-03-04)

### ⚠ BREAKING CHANGES

- isolate usage delta baselines by acpSessionId
  ([#1274](https://github.com/loro-dev/lody/issues/1274))

### Features

- add built-in opencode ACP support
  ([#1221](https://github.com/loro-dev/lody/issues/1221))
  ([4e8b644](https://github.com/loro-dev/lody/commit/4e8b6447d9264f20e0ff354cc1bd0bedaddc6c60))
- new acp, context window
  ([#1273](https://github.com/loro-dev/lody/issues/1273))
  ([a523942](https://github.com/loro-dev/lody/commit/a523942cc5271503f8cc373b3ea12017084c457c))
- remove local project path mapping and persist absolute paths
  ([#1240](https://github.com/loro-dev/lody/issues/1240))
  ([5c991f8](https://github.com/loro-dev/lody/commit/5c991f89b2a8d7d46eba7c4f84e1edd70ea0b92b))
- upgrade claude acp
  ([21b75a0](https://github.com/loro-dev/lody/commit/21b75a07ac006bc204fadf0ea2015d273f04db53))

### Bug Fixes

- fix:
  ([16347e9](https://github.com/loro-dev/lody/commit/16347e90f451d251ced080b32ff4a4130edded8a))
- await pending usage update handlers before flushing to prevent race
  ([#1267](https://github.com/loro-dev/lody/issues/1267))
  ([d257015](https://github.com/loro-dev/lody/commit/d257015e5ab88b39d00fd1416757cbfecfe59d25))
- **cli:** use session base branch for diff stats
  ([#1238](https://github.com/loro-dev/lody/issues/1238))
  ([d9ba0a4](https://github.com/loro-dev/lody/commit/d9ba0a4cecda6e28243e283e5afb65b1c8ffe6bd))
- codex quota limit ([#1276](https://github.com/loro-dev/lody/issues/1276))
  ([e2e0d63](https://github.com/loro-dev/lody/commit/e2e0d632c4a753316aac8760bbd3dda37df93dd2))
- distinguish duplicated codex rate limits in settings
  ([#1258](https://github.com/loro-dev/lody/issues/1258))
  ([97fc675](https://github.com/loro-dev/lody/commit/97fc675398b621ef4070fdbf63d6ecb96781fc9c))
- preserve plan expand/collapse state across virtual scroll unmount
  ([#1261](https://github.com/loro-dev/lody/issues/1261))
  ([c78146d](https://github.com/loro-dev/lody/commit/c78146d53127658ccd348a60e630586c5ca5845f))
- report usage at turn end and align codex snapshot semantics
  ([#1257](https://github.com/loro-dev/lody/issues/1257))
  ([1fa8aa5](https://github.com/loro-dev/lody/commit/1fa8aa5df483e930b3b8f32f8b3709be25a244a2))
- restore user's permission level after agent exits plan mode
  ([#1270](https://github.com/loro-dev/lody/issues/1270))
  ([d065647](https://github.com/loro-dev/lody/commit/d0656473d4b832f2d793097280fcd33d207a7e29))
- tighten cli shutdown cleanup for local services
  ([#1220](https://github.com/loro-dev/lody/issues/1220))
  ([9f57c8e](https://github.com/loro-dev/lody/commit/9f57c8e07f8c9d7cf8249334a344af63055f69c1))
- windows deeplink callback and spawn shell options
  ([#1224](https://github.com/loro-dev/lody/issues/1224))
  ([22b03e8](https://github.com/loro-dev/lody/commit/22b03e831912bc4cfe12b72ed2eff045dd507902))

### Refactors

- isolate usage delta baselines by acpSessionId
  ([#1274](https://github.com/loro-dev/lody/issues/1274))
  ([5d35939](https://github.com/loro-dev/lody/commit/5d359399ee073651b9a417c6b543adb897b8ce2f))

### Documentation

- unified New Session landing page design
  ([#1259](https://github.com/loro-dev/lody/issues/1259))
  ([6884bfa](https://github.com/loro-dev/lody/commit/6884bfa61dab50e33bcbb182f38cf25a17b9cb22))

## [0.32.5](https://github.com/loro-dev/lody/compare/lody-cli-v0.32.4...lody-cli-v0.32.5) (2026-02-26)

### Bug Fixes

- **cli:** require only one local agent CLI by default
  ([#1222](https://github.com/loro-dev/lody/issues/1222))
  ([1766dfd](https://github.com/loro-dev/lody/commit/1766dfdf7d58b852dd3f1fa022639a14dc285dd8))

## [0.32.4](https://github.com/loro-dev/lody/compare/lody-cli-v0.32.3...lody-cli-v0.32.4) (2026-02-26)

### Chores

- **lody-cli:** Synchronize lody-cli-electron versions

## [0.32.3](https://github.com/loro-dev/lody/compare/lody-cli-v0.32.2...lody-cli-v0.32.3) (2026-02-22)

### Chores

- **lody-cli:** Synchronize lody-cli-electron versions

## [0.32.2](https://github.com/loro-dev/lody/compare/lody-cli-v0.32.1...lody-cli-v0.32.2) (2026-02-22)

### Chores

- **lody-cli:** Synchronize lody-cli-electron versions

## [0.32.1](https://github.com/loro-dev/lody/compare/lody-cli-v0.32.0...lody-cli-v0.32.1) (2026-02-22)

### Bug Fixes

- ci build ([#1199](https://github.com/loro-dev/lody/issues/1199))
  ([1074ad3](https://github.com/loro-dev/lody/commit/1074ad32867cc27e23c48ba9f050f4031926cc1d))
- test ([#1201](https://github.com/loro-dev/lody/issues/1201))
  ([9d30440](https://github.com/loro-dev/lody/commit/9d3044079353f5251eaa1f0d5b7f0181e46929ef))

## [0.32.0](https://github.com/loro-dev/lody/compare/lody-cli-v0.31.2...lody-cli-v0.32.0) (2026-02-22)

### Features

- add branch-aware session startup
  ([#1102](https://github.com/loro-dev/lody/issues/1102))
  ([bac1b50](https://github.com/loro-dev/lody/commit/bac1b5076ac3678f997427dff472691ebd003585))
- add electron local-first session control path
  ([#1169](https://github.com/loro-dev/lody/issues/1169))
  ([41d5e96](https://github.com/loro-dev/lody/commit/41d5e961bcb0d9258326da7c0cb2c362a2ffcddb))
- bootstrap Electron CLI auth from session token
  ([#1148](https://github.com/loro-dev/lody/issues/1148))
  ([77b2bfa](https://github.com/loro-dev/lody/commit/77b2bfaf7bdef4d107bfc900773769c5ff2664ec))
- **cli:** implement transparent gh shim for PR workflows
  ([#1163](https://github.com/loro-dev/lody/issues/1163))
  ([d675614](https://github.com/loro-dev/lody/commit/d675614a987970262ab6c00be98b199d640b9b20))
- **cli:** load environment variables based on runtime environment
  ([758d310](https://github.com/loro-dev/lody/commit/758d310e01d6ab93bccddcaee5bccfb4fdb15010))
- **cli:** simplify start defaults and remove prompts
  ([#1117](https://github.com/loro-dev/lody/issues/1117))
  ([bb09e1c](https://github.com/loro-dev/lody/commit/bb09e1ced390f2faa4fd668cd29fb7bdee8edaa5))
- electron deeplink Auth ([#1142](https://github.com/loro-dev/lody/issues/1142))
  ([36bb712](https://github.com/loro-dev/lody/commit/36bb712df401988280fcd8e908a41f20acb46f3a))
- **electron:** add desktop notification toggle with system settings guidance
  ([#1110](https://github.com/loro-dev/lody/issues/1110))
  ([293dc74](https://github.com/loro-dev/lody/commit/293dc74d555d83cda4640c5e37e03350d5613ecd))
- **electron:** local projects
  ([#1060](https://github.com/loro-dev/lody/issues/1060))
  ([166bffe](https://github.com/loro-dev/lody/commit/166bffe8ec03758a82c7a8e49c9ab423b6c5f239))
- enable GitHub capabilities for linked local projects
  ([#1170](https://github.com/loro-dev/lody/issues/1170))
  ([a9b5d87](https://github.com/loro-dev/lody/commit/a9b5d87b71c3894037e2f2e8767155bcaab980d0))
- move local project implementation to CLI daemon
  ([#1192](https://github.com/loro-dev/lody/issues/1192))
  ([508b8c0](https://github.com/loro-dev/lody/commit/508b8c0adb0a5d2fb9b6ab3fd71343e3708ab6b7))

### Bug Fixes

- bump selector font size and normalize codex spark labels
  ([#1176](https://github.com/loro-dev/lody/issues/1176))
  ([71bda6b](https://github.com/loro-dev/lody/commit/71bda6bc06cb5b77e3108e06d0b363e803e469b6))
- claude acp
  ([0e3f062](https://github.com/loro-dev/lody/commit/0e3f062010f28d5ad05bd884593e7526589ed9b2))
- **cli:** cleanup failed Loro init to prevent listener leaks
  ([#1143](https://github.com/loro-dev/lody/issues/1143))
  ([2f876e5](https://github.com/loro-dev/lody/commit/2f876e5240e780f09e8b97d4a25b1dd84181fb86))
- **cli:** normalize SITE_APP_BASE_PATH for device verification URL
  ([ba22d77](https://github.com/loro-dev/lody/commit/ba22d77a2088828dc60c21c3b137ccf4faf6d1da))
- **cli:** precheck existing start process before login
  ([#1156](https://github.com/loro-dev/lody/issues/1156))
  ([16f16ba](https://github.com/loro-dev/lody/commit/16f16baf0d390923d6c811c83b10fdc35f9f896d))
- **cli:** preserve local projects on machine re-register
  ([#1120](https://github.com/loro-dev/lody/issues/1120))
  ([c969675](https://github.com/loro-dev/lody/commit/c9696757574e80a8ae1c147ddd372d1c314499e7))
- stabilize loro-repo sync migration and flock-wasm bundler checks
  ([#1129](https://github.com/loro-dev/lody/issues/1129))
  ([aabe3ea](https://github.com/loro-dev/lody/commit/aabe3ea14d795d1b0a9f81ae527ba339adac2026))
- trigger cli release
  ([2b81437](https://github.com/loro-dev/lody/commit/2b8143742eba37fb0bb3f445e1e0406d57b6c0b7))
- use betterAuthClient for AuthClient auth validation
  ([#1161](https://github.com/loro-dev/lody/issues/1161))
  ([a83097a](https://github.com/loro-dev/lody/commit/a83097a61777ee5bf797cda1a7c527fa5ddce54b))

### Performance

- **cli:** reduce npx install size by removing bundled deps and sourcemaps
  ([#1136](https://github.com/loro-dev/lody/issues/1136))
  ([ce053c5](https://github.com/loro-dev/lody/commit/ce053c50a1e0e3446b09cb8a6730091d3a1ddf17))

### Refactors

- **cli:** native-only runtime, remove docker/background modes
  ([#1160](https://github.com/loro-dev/lody/issues/1160))
  ([e5a475d](https://github.com/loro-dev/lody/commit/e5a475de53f959f5f2ec7e16f6242bf4c48788fa))

## [0.31.2](https://github.com/loro-dev/lody/compare/lody-cli-v0.31.1...lody-cli-v0.31.2) (2026-02-06)

### Bug Fixes

- gpt-5.3 price
  ([e6e4cfe](https://github.com/loro-dev/lody/commit/e6e4cfe1dde1b6d642e1bd8a2c48fe2b7fb8e923))

## [0.31.1](https://github.com/loro-dev/lody/compare/lody-cli-v0.31.0...lody-cli-v0.31.1) (2026-02-06)

### Bug Fixes

- cli auth url
  ([27e052c](https://github.com/loro-dev/lody/commit/27e052c48aa599db8833f174b58a9571a26609bc))

## [0.31.0](https://github.com/loro-dev/lody/compare/lody-cli-v0.30.0...lody-cli-v0.31.0) (2026-02-06)

### Features

- add local CLI probe, shared worktree paths, and Open in VS Code button
  ([#1017](https://github.com/loro-dev/lody/issues/1017))
  ([8cb32e4](https://github.com/loro-dev/lody/commit/8cb32e47ff65002f060d146aceacc02630b1747d))
- **auth:** user-scoped CLI token + multi-workspace support
  ([#1048](https://github.com/loro-dev/lody/issues/1048))
  ([1da6f20](https://github.com/loro-dev/lody/commit/1da6f20dd6c2e25116da0973814b59a1c77dfc9d))
- basic electron ([#1015](https://github.com/loro-dev/lody/issues/1015))
  ([3019fc9](https://github.com/loro-dev/lody/commit/3019fc91ced6e8cbe1f03124bb10e6238e9a1bb4))
- chat mentions ([#1028](https://github.com/loro-dev/lody/issues/1028))
  ([62d53c6](https://github.com/loro-dev/lody/commit/62d53c6845cd94aa8c491557b04a315ac9219a1c))
- electron start cli ([#1047](https://github.com/loro-dev/lody/issues/1047))
  ([aed10db](https://github.com/loro-dev/lody/commit/aed10dbd8f25f7d6d9935483b48cbd03257822f2))
- include issue/PR mentions in ACP prompt
  ([#1080](https://github.com/loro-dev/lody/issues/1080))
  ([f379fa9](https://github.com/loro-dev/lody/commit/f379fa90aac34d70843d1dc4ec96c810a2c97d57))
- release 2026-02-06
  ([3872d71](https://github.com/loro-dev/lody/commit/3872d7117283eb3b10ff4553e005604ee0a037b2))
- release please
  ([6c363e8](https://github.com/loro-dev/lody/commit/6c363e8acd477ea0cfc65e81adf95d7bb67f3337))
- upgrade acp ([#1081](https://github.com/loro-dev/lody/issues/1081))
  ([0343089](https://github.com/loro-dev/lody/commit/03430895993d8b2403845b0e88b03837e11a37cb))

### Bug Fixes

- **cli:** always enforce minimum 6GB memory per container
  ([#1038](https://github.com/loro-dev/lody/issues/1038))
  ([c3d4194](https://github.com/loro-dev/lody/commit/c3d41947e795e044a443a54a73b3ea77e6ff7a5a))
- **cli:** inject agent config env on resume
  ([#1071](https://github.com/loro-dev/lody/issues/1071))
  ([c4e203f](https://github.com/loro-dev/lody/commit/c4e203ff56c3f32077f5056ce87d8067325abf2d))
- **cli:** prevent silent exit in bundled build
  ([#1070](https://github.com/loro-dev/lody/issues/1070))
  ([66a467d](https://github.com/loro-dev/lody/commit/66a467dd9e6a9a0f3e33de91dc029af23549a410))
- **cli:** reduce noisy prompt pending warnings
  ([#1033](https://github.com/loro-dev/lody/issues/1033))
  ([651b3e9](https://github.com/loro-dev/lody/commit/651b3e95a630f4321d6717210d51e8872af4dc34))
- **cli:** show detailed ACP error messages in Web UI
  ([#1024](https://github.com/loro-dev/lody/issues/1024))
  ([6c00a90](https://github.com/loro-dev/lody/commit/6c00a90f34ef278da1daf957f8e29aaadbf718f5))
- context window & usage calc
  ([#1067](https://github.com/loro-dev/lody/issues/1067))
  ([3625a6e](https://github.com/loro-dev/lody/commit/3625a6e56680b8914d3e3a4d9cb1eb56ed43fba7))
- gh wrapper
  ([cc89334](https://github.com/loro-dev/lody/commit/cc89334ccefe44a267399dd97db41e5fad65ebf7))

## [0.30.0](https://github.com/loro-dev/lody/compare/lody-cli-v0.29.3...lody-cli-v0.30.0) (2026-01-27)

### Features

- **cli:** add ACP idle timer to auto-shutdown inactive sessions after 3 hours
  ([#1009](https://github.com/loro-dev/lody/issues/1009))
  ([293c2b3](https://github.com/loro-dev/lody/commit/293c2b30d30fb291d0a7b9d045744475ea7920c6))
- **components:** implement archive sessions view
  ([#983](https://github.com/loro-dev/lody/issues/983))
  ([d5fc814](https://github.com/loro-dev/lody/commit/d5fc81412723141239fe437501838f15e50a24c2))

### Bug Fixes

- fix:
  ([2180c11](https://github.com/loro-dev/lody/commit/2180c111ed889080ff651d1c47e83c68c5da251b))
- **cli:** accumulate buffers before decoding to handle split multi-byte chars
  ([945edfe](https://github.com/loro-dev/lody/commit/945edfece547772ceea3d38476104a335fa6119f))
- **cli:** add user to /etc/passwd when running container with host UID
  ([#1002](https://github.com/loro-dev/lody/issues/1002))
  ([71354b8](https://github.com/loro-dev/lody/commit/71354b83795bef23327a670ed552f9e5572e2173))
- **cli:** handle Windows code page encoding for terminal output
  ([6db63a3](https://github.com/loro-dev/lody/commit/6db63a37832f50d26d109559b8ed98021f5d2810))
- **cli:** preserve raceLimits when re-registering machine
  ([#996](https://github.com/loro-dev/lody/issues/996))
  ([ed2518e](https://github.com/loro-dev/lody/commit/ed2518e05a32b476428cd85087fee77567a25155))
- **cli:** remove debug log that breaks bash tool due to BigInt serialization
  ([#1006](https://github.com/loro-dev/lody/issues/1006))
  ([6714657](https://github.com/loro-dev/lody/commit/671465735e31e498d0c26039fc3fd5bf48998cc3))
- **cli:** remove TypeScript syntax from .cjs wrapper source
  ([#997](https://github.com/loro-dev/lody/issues/997))
  ([55c27d2](https://github.com/loro-dev/lody/commit/55c27d23811af8161851da414619a01dafeaee1a))
- gh wrapper
  ([3fb7f5b](https://github.com/loro-dev/lody/commit/3fb7f5beac7faec48ddff2d876b42377b350c08d))

## [0.28.17-next.1](https://github.com/loro-dev/lody/compare/lody-cli-v0.28.16-next.1...lody-cli-v0.28.17-next.1) (2026-01-27)

### Features

- **cli:** add ACP idle timer to auto-shutdown inactive sessions after 3 hours
  ([#1009](https://github.com/loro-dev/lody/issues/1009))
  ([293c2b3](https://github.com/loro-dev/lody/commit/293c2b30d30fb291d0a7b9d045744475ea7920c6))

### Bug Fixes

- fix:
  ([2180c11](https://github.com/loro-dev/lody/commit/2180c111ed889080ff651d1c47e83c68c5da251b))
- gh wrapper
  ([3fb7f5b](https://github.com/loro-dev/lody/commit/3fb7f5beac7faec48ddff2d876b42377b350c08d))

## [0.29.3](https://github.com/loro-dev/lody/compare/lody-cli-v0.29.2...lody-cli-v0.29.3) (2026-01-23)

### Bug Fixes

- **cli:** resolve Windows spawn ENOENT errors
  ([#985](https://github.com/loro-dev/lody/issues/985))
  ([9a639aa](https://github.com/loro-dev/lody/commit/9a639aa2c3ed838604f8adb57c0c4d2d77779351))

## [0.29.2](https://github.com/loro-dev/lody/compare/lody-cli-v0.29.1...lody-cli-v0.29.2) (2026-01-23)

### Bug Fixes

- z.ai
  ([6337f8a](https://github.com/loro-dev/lody/commit/6337f8a48cd1a2ef98b44e7d45f00f774cef0a45))

## [0.29.1](https://github.com/loro-dev/lody/compare/lody-cli-v0.29.0...lody-cli-v0.29.1) (2026-01-21)

### Bug Fixes

- **cli:** prevent container reuse across different home directories
  ([29fe79b](https://github.com/loro-dev/lody/commit/29fe79bef6bd76575212fd8824ba08aa68dd3ffd))
- rename claude bin ([#955](https://github.com/loro-dev/lody/issues/955))
  ([7375d2f](https://github.com/loro-dev/lody/commit/7375d2ff9ee1b07ca59aa979f438cb428b6ffa6d))

## [0.29.0](https://github.com/loro-dev/lody/compare/lody-cli-v0.28.1...lody-cli-v0.29.0) (2026-01-20)

### ⚠ BREAKING CHANGES

- **session-status:** SessionStatus type reduced to 3 states

### Features

- add Docker container resource limits and idle container eviction
  ([#888](https://github.com/loro-dev/lody/issues/888))
  ([e89e53c](https://github.com/loro-dev/lody/commit/e89e53c9c2a424f2d5cee427db4721d5025cfa0f))
- add time synchronization for consistent online status detection
  ([#884](https://github.com/loro-dev/lody/issues/884))
  ([11fa316](https://github.com/loro-dev/lody/commit/11fa3160ecb20d430813c2a92634b17ae5b0569a))
- add workspace dirty state detection and commit & push action
  ([#902](https://github.com/loro-dev/lody/issues/902))
  ([4a7b65e](https://github.com/loro-dev/lody/commit/4a7b65e0d9252b340ff3279061f0205f7ec93a4c))
- claude code & codex token usage
  ([#867](https://github.com/loro-dev/lody/issues/867))
  ([e922589](https://github.com/loro-dev/lody/commit/e9225896ae60f3dee3f69f71b687f3765d78bc53))
- **cli:** add 1-hour minimum GC protection for active sessions
  ([#824](https://github.com/loro-dev/lody/issues/824))
  ([e99a708](https://github.com/loro-dev/lody/commit/e99a70881e8f9de9c3d71222d75e733671924196))
- **cli:** add automatic Docker socket detection for macOS (OrbStack, Colima)
  ([#868](https://github.com/loro-dev/lody/issues/868))
  ([4d0f1f1](https://github.com/loro-dev/lody/commit/4d0f1f1e8558852cf26b6b9c11617916959612d5))
- **cli:** implement session garbage collection for memory optimization
  ([#813](https://github.com/loro-dev/lody/issues/813))
  ([05d8570](https://github.com/loro-dev/lody/commit/05d85704be7974a383fac9340a77903be064d70b))
- **cli:** optimize logging with timestamps and ACP notification persistence
  ([#844](https://github.com/loro-dev/lody/issues/844))
  ([f483032](https://github.com/loro-dev/lody/commit/f4830329724a607d7353cb5de6c8f1baa8abe0c5))
- dynamic container resource allocation with machine status UI
  ([#891](https://github.com/loro-dev/lody/issues/891))
  ([eff4235](https://github.com/loro-dev/lody/commit/eff4235a6a4f3bda763bb980befaf8f40cc245f9))
- **github-auth:** store session ownership in Convex instead of querying Loro DO
  ([#838](https://github.com/loro-dev/lody/issues/838))
  ([bfcb519](https://github.com/loro-dev/lody/commit/bfcb5195eba07e9b577fef15f169b53fb7af8fbc))
- show turn duration in session history
  ([#650](https://github.com/loro-dev/lody/issues/650))
  ([404fd4c](https://github.com/loro-dev/lody/commit/404fd4c7a5eff901b7f4e35bb81e4e08c265e5b8))
- use LoroDoc subscription for permission request/response flow
  ([#808](https://github.com/loro-dev/lody/issues/808))
  ([3aa126d](https://github.com/loro-dev/lody/commit/3aa126dd17d764438a0bfc6e2816d4dc6adcb8f5))

### Bug Fixes

- add cli logs
  ([cb09480](https://github.com/loro-dev/lody/commit/cb09480ec61a43950953e71e9ff71b9232dc4249))
- add JSON response body to all broker error responses
  ([#886](https://github.com/loro-dev/lody/issues/886))
  ([749928e](https://github.com/loro-dev/lody/commit/749928e22a9126f8f98071938d5a14c3122d6fdf))
- claude acp version ([#908](https://github.com/loro-dev/lody/issues/908))
  ([1443277](https://github.com/loro-dev/lody/commit/1443277f66f0e54a6cb92c77922ec97b155a9408))
- **cli:** add debugging logs for ACP client initialization hang
  ([#864](https://github.com/loro-dev/lody/issues/864))
  ([bcc0499](https://github.com/loro-dev/lody/commit/bcc04990cead49bc6e081931d9c8ca9673c32f25))
- **cli:** add Homebrew paths to checkClaude detection
  ([#903](https://github.com/loro-dev/lody/issues/903))
  ([792a291](https://github.com/loro-dev/lody/commit/792a291108db30ddfd6a33fd91416c0064b11714))
- **cli:** add missing heartbeat start/stop in handleSessionChat
  ([#848](https://github.com/loro-dev/lody/issues/848))
  ([6af611e](https://github.com/loro-dev/lody/commit/6af611e471fc59d404d53904279dd4990c6f21ff))
- **cli:** add retry and graceful degradation for ACP transport errors
  ([#905](https://github.com/loro-dev/lody/issues/905))
  ([0da74a9](https://github.com/loro-dev/lody/commit/0da74a99404392e579eb831b23b180539b8a5c8a))
- **cli:** avoid shutdown deadlock on drain
  ([#810](https://github.com/loro-dev/lody/issues/810))
  ([7a7a5c5](https://github.com/loro-dev/lody/commit/7a7a5c5e9e6d9ed55d79f72d5283ec9d6dba4151))
- **cli:** check for running service before user interaction prompts
  ([#895](https://github.com/loro-dev/lody/issues/895))
  ([9d21099](https://github.com/loro-dev/lody/commit/9d21099f0958b685ff5f303d4c8c9eedb29d13a0))
- **cli:** Docker mode fixes and performance improvements
  ([#865](https://github.com/loro-dev/lody/issues/865))
  ([81c4c24](https://github.com/loro-dev/lody/commit/81c4c24bd91f4f279f64bf94548c726e79832ea5))
- **cli:** ensure git commits use current user's identity, not session creator's
  ([#885](https://github.com/loro-dev/lody/issues/885))
  ([3276205](https://github.com/loro-dev/lody/commit/32762054ada629680dbf4449ecf76e2a76d07061))
- **cli:** fix Docker container permission and stdin backpressure issues
  ([#828](https://github.com/loro-dev/lody/issues/828))
  ([7fada41](https://github.com/loro-dev/lody/commit/7fada4158a03d277d7c5037aeb3bbe9cc487eb7c))
- **cli:** handle ACP JSON-RPC errors in handleTurnError
  ([#943](https://github.com/loro-dev/lody/issues/943))
  ([2a69122](https://github.com/loro-dev/lody/commit/2a69122d673504779160dbb65125f33f05470796))
- **cli:** handle agent disconnection errors and notify user via session history
  ([#928](https://github.com/loro-dev/lody/issues/928))
  ([0bd9d3f](https://github.com/loro-dev/lody/commit/0bd9d3fbf6e6a7e19a11ab72c7a5b77abd521900))
- **cli:** handle EPIPE errors on agent stdin to prevent crashes
  ([#833](https://github.com/loro-dev/lody/issues/833))
  ([8920287](https://github.com/loro-dev/lody/commit/8920287acc578de764724040465122a41e0cb4a5))
- **cli:** output ACP logs to console only in debug mode
  ([#935](https://github.com/loro-dev/lody/issues/935))
  ([e7ffab7](https://github.com/loro-dev/lody/commit/e7ffab773977cae0d436b20386b9c4f0be54d02d))
- **cli:** prevent stdout data loss race condition in ACP stream creation
  ([#822](https://github.com/loro-dev/lody/issues/822))
  ([4f64cc2](https://github.com/loro-dev/lody/commit/4f64cc20226e0b98e016ae70a081d66e732d5678))
- **cli:** remove .lody-session-id file, extract session ID from worktree path
  ([#869](https://github.com/loro-dev/lody/issues/869))
  ([01286ea](https://github.com/loro-dev/lody/commit/01286eabc2401ad2b0249a25e89efb013f36bdda))
- **cli:** use acp-extension packages and check local node_modules/.bin
  ([#930](https://github.com/loro-dev/lody/issues/930))
  ([e42120a](https://github.com/loro-dev/lody/commit/e42120adbc958c668170b562dabf2eb63cdc9651))
- **cli:** use Docker-reported CPU count for container resource limits
  ([#899](https://github.com/loro-dev/lody/issues/899))
  ([ec6c229](https://github.com/loro-dev/lody/commit/ec6c229bffdc0cfa8a43df86c409cdae3c00aeb6))
- **cli:** use host UID/GID for Docker containers to avoid permission issues
  ([#861](https://github.com/loro-dev/lody/issues/861))
  ([e014b9e](https://github.com/loro-dev/lody/commit/e014b9e7c10d10482bbeb22404ec48cf6725fdb5))
- **cli:** use rslave bind propagation and retry for Docker workdir visibility
  ([#818](https://github.com/loro-dev/lody/issues/818))
  ([0ecccfa](https://github.com/loro-dev/lody/commit/0ecccfa9902e7ef5e8fad5d5c07a883b617d3fe5))
- **cli:** use user token for gh commands requiring elevated permissions
  ([#889](https://github.com/loro-dev/lody/issues/889))
  ([d9b593f](https://github.com/loro-dev/lody/commit/d9b593f73cc460d292fc0476f3b39d0b003ae44a))
- **cli:** validate workdir exists before starting agent in Docker mode
  ([#816](https://github.com/loro-dev/lody/issues/816))
  ([44fc1bf](https://github.com/loro-dev/lody/commit/44fc1bf042a774af0eb995a6c72ce02fbae97078))
- **cli:** wait for meta room full sync to prevent duplicate agent registration
  ([#917](https://github.com/loro-dev/lody/issues/917))
  ([2faed2a](https://github.com/loro-dev/lody/commit/2faed2afe248b33227fc8bfdbb9a7cf1a8d2404c))
- dockerfile ([#926](https://github.com/loro-dev/lody/issues/926))
  ([65d08ca](https://github.com/loro-dev/lody/commit/65d08cade2b869a2e602de7ecb8852d1f2e0d893))
- ensure container dirs have correct permissions for non-1000 UID
  ([#910](https://github.com/loro-dev/lody/issues/910))
  ([f0cae11](https://github.com/loro-dev/lody/commit/f0cae1143e931c33ff1ecfcfec0273e8c26e2015))
- ensure notification updates are associated with correct conversation turn
  ([#883](https://github.com/loro-dev/lody/issues/883))
  ([86854d2](https://github.com/loro-dev/lody/commit/86854d293c29417841b31a84657b2d2df6c8be2f))
- ensure PATH includes npm-global bin for Docker ACP agent
  ([#913](https://github.com/loro-dev/lody/issues/913))
  ([2a8f8dd](https://github.com/loro-dev/lody/commit/2a8f8ddc0b0578d6fe6c718aa8122575f5044040))
- **github-auth:** move session owner registration to web client
  ([#839](https://github.com/loro-dev/lody/issues/839))
  ([2c29057](https://github.com/loro-dev/lody/commit/2c29057af1ff7411031e11d2ada460526dd0afe5))
- improve message delivery reliability with ACK mechanism and failure tracking
  ([#890](https://github.com/loro-dev/lody/issues/890))
  ([fa6d35e](https://github.com/loro-dev/lody/commit/fa6d35e3f473255c225a811b272d52ef6be2490b))
- **loro-code:** fix setLatestAssistantHistoryFileDiff not setting fileDiff
  ([#819](https://github.com/loro-dev/lody/issues/819))
  ([9b1391a](https://github.com/loro-dev/lody/commit/9b1391a5c6b757340856670974641da0e95ccfc7))
- mobile settings layout fix & linux docker git broker issue
  ([#876](https://github.com/loro-dev/lody/issues/876))
  ([0d5d38b](https://github.com/loro-dev/lody/commit/0d5d38bd15a346c5e522181c0d3b7d80594fdbde))
- record turn duration on agent turn instead of user turn
  ([#814](https://github.com/loro-dev/lody/issues/814))
  ([fb9a099](https://github.com/loro-dev/lody/commit/fb9a09911f20bbea5aca6c87819f2d7ac232a355))
- remove unused imports and variables
  ([#872](https://github.com/loro-dev/lody/issues/872))
  ([3e48fea](https://github.com/loro-dev/lody/commit/3e48feaf083cee2850271b1f31ceb7160108ea0c))
- **timestamps:** use calibrated server time for session timestamps
  ([#937](https://github.com/loro-dev/lody/issues/937))
  ([46d1c7b](https://github.com/loro-dev/lody/commit/46d1c7b2f1818d35c5e154bb8211fdcc6d0a6fa5))
- update codex
  ([e8fd685](https://github.com/loro-dev/lody/commit/e8fd685dcef64144c6e2370a197ef1fae716a5b3))
- usage ([#894](https://github.com/loro-dev/lody/issues/894))
  ([8bb2802](https://github.com/loro-dev/lody/commit/8bb2802ff363f30c2bfa809cbe83549deadada37))

### Performance

- **cli:** reduce git credential latency
  ([#863](https://github.com/loro-dev/lody/issues/863))
  ([fbc4856](https://github.com/loro-dev/lody/commit/fbc48566b9da39af1663e078ef9075327d9b42a2))
- **cli:** speed up Docker container cleanup on exit
  ([#806](https://github.com/loro-dev/lody/issues/806))
  ([6845e54](https://github.com/loro-dev/lody/commit/6845e54ef03a2dfe1bb35785b89a1038a2f790ca))

### Refactors

- **cli:** remove throttle from ACP notification updates for better streaming
  ([#835](https://github.com/loro-dev/lody/issues/835))
  ([56b1491](https://github.com/loro-dev/lody/commit/56b1491d3dc8b3812cd867131e535a8b9264f0d7))
- **cli:** simplify session GC to use 2h idle timeout + LRU max 10 sessions
  ([#831](https://github.com/loro-dev/lody/issues/831))
  ([d7d62d3](https://github.com/loro-dev/lody/commit/d7d62d344157d026e77d62244563acf66c56162d))
- derive turn duration from timestamp
  ([#850](https://github.com/loro-dev/lody/issues/850))
  ([5eada95](https://github.com/loro-dev/lody/commit/5eada953016b35dfc7186d1b0a83eaf9ef72155f))
- **session-status:** simplify state machine from 13 to 3 states
  ([#843](https://github.com/loro-dev/lody/issues/843))
  ([30e6593](https://github.com/loro-dev/lody/commit/30e659357975f09d93c7a89734282dcdeeeb6c9d))

### Documentation

- update cli readme
  ([409ae31](https://github.com/loro-dev/lody/commit/409ae318fb0d4c188b441092e308fcfbcd55abd6))

## [0.28.1](https://github.com/loro-dev/lody/compare/lody-cli-v0.28.0...lody-cli-v0.28.1) (2026-01-13)

### Bug Fixes

- **cli:** preserve original case in GitHub repo names
  ([#802](https://github.com/loro-dev/lody/issues/802))
  ([fc3b959](https://github.com/loro-dev/lody/commit/fc3b95946e48afc787ab89343e9fdafa9eb6d165))

## [0.28.0](https://github.com/loro-dev/lody/compare/lody-cli-v0.27.0...lody-cli-v0.28.0) (2026-01-12)

### Features

- **cli:** add Claude Code ACP support and refactor plan storage
  ([#678](https://github.com/loro-dev/lody/issues/678))
  ([809e4fc](https://github.com/loro-dev/lody/commit/809e4fc3e9a58b6398de3995b24d0f20e293d7e6))
- **cli:** add concurrent message processing for multiple sessions
  ([#621](https://github.com/loro-dev/lody/issues/621))
  ([16a938d](https://github.com/loro-dev/lody/commit/16a938daba951d694f1d2590bf0b8fc12349a69d))
- **cli:** add proxy support for WebSocket connections
  ([#615](https://github.com/loro-dev/lody/issues/615))
  ([b1bb613](https://github.com/loro-dev/lody/commit/b1bb613cd96c50fa07d3feeb9373f32f4f9a9900))
- **cli:** create PRs as GitHub user
  ([#732](https://github.com/loro-dev/lody/issues/732))
  ([4a93274](https://github.com/loro-dev/lody/commit/4a93274c3339e09f2bcb9507316df36d74f99c45))
- **cli:** disable timestamp in log output unless --debug flag is used
  ([#616](https://github.com/loro-dev/lody/issues/616))
  ([4b90870](https://github.com/loro-dev/lody/commit/4b908707016b7ecf33f350e65565ddc3addda808))
- code session and diff files
  ([#618](https://github.com/loro-dev/lody/issues/618))
  ([6954c64](https://github.com/loro-dev/lody/commit/6954c64c7425aedd5e71540795ad99c84025bba6))
- shorten default branch name and improve branch name UX
  ([#546](https://github.com/loro-dev/lody/issues/546))
  ([1f7da89](https://github.com/loro-dev/lody/commit/1f7da8924a8a38dcfdded73001bd0064bbf5cb19))
- use user's GitHub credentials for git commits
  ([#713](https://github.com/loro-dev/lody/issues/713))
  ([974dd5b](https://github.com/loro-dev/lody/commit/974dd5ba7b36a4c7dcb530eb237d61212a668a46))
- **web:** upgrade loro-repo to 0.10.0 and enable flock-sqlite mode
  ([#636](https://github.com/loro-dev/lody/issues/636))
  ([8347ab8](https://github.com/loro-dev/lody/commit/8347ab8d87efc359021a5ff54176354758299f23))

### Bug Fixes

- add clean URL rewrites for landing page docs
  ([#697](https://github.com/loro-dev/lody/issues/697))
  ([29251fd](https://github.com/loro-dev/lody/commit/29251fdd7025b8c4663933236143e1655df52fdc))
- **cli:** async branch rename on session create
  ([#625](https://github.com/loro-dev/lody/issues/625))
  ([9aaa9a0](https://github.com/loro-dev/lody/commit/9aaa9a094ef0d1b3aef4a7c6de1cb0d0f43c1737))
- **cli:** avoid logging file contents in session-related logs
  ([#674](https://github.com/loro-dev/lody/issues/674))
  ([8037bf5](https://github.com/loro-dev/lody/commit/8037bf581dab532d60cfc007e19c36b531e457e4))
- **cli:** clear machine tombstone on reconnect to prevent stale offline status
  ([#741](https://github.com/loro-dev/lody/issues/741))
  ([466bd50](https://github.com/loro-dev/lody/commit/466bd508b00f6c1ef4a203e526efb5fc54ca4dcf))
- **cli:** ensure GitHubTokenManager never returns expired tokens
  ([#689](https://github.com/loro-dev/lody/issues/689))
  ([82f0383](https://github.com/loro-dev/lody/commit/82f03836269f4b966b949421c997698f15e894a3))
- **cli:** fix session status stuck in Running state
  ([#757](https://github.com/loro-dev/lody/issues/757))
  ([8b6bc26](https://github.com/loro-dev/lody/commit/8b6bc262887d9e1d31bd6b12e42e25b0e9b8a541))
- **cli:** normalize log output
  ([#728](https://github.com/loro-dev/lody/issues/728))
  ([35ca925](https://github.com/loro-dev/lody/commit/35ca925b43679b33042fe8994d259fa98be93448))
- **cli:** prevent session status stuck running
  ([#669](https://github.com/loro-dev/lody/issues/669))
  ([bcbb8c3](https://github.com/loro-dev/lody/commit/bcbb8c36c5a81bd43f28e3b82a8ff8aa43141ab3))
- **cli:** set session completed status and unread state immediately after
  prompt returns ([#687](https://github.com/loro-dev/lody/issues/687))
  ([acd5769](https://github.com/loro-dev/lody/commit/acd5769a4bd278eaf9dde2ae6edf88a478c554b3))
- **cli:** suppress native exec stdout logging
  ([#719](https://github.com/loro-dev/lody/issues/719))
  ([f2e475d](https://github.com/loro-dev/lody/commit/f2e475d47cee651db6efb83ea102fe8cbf86d7f4))
- **cli:** use host workdir for code-session diff in docker
  ([#671](https://github.com/loro-dev/lody/issues/671))
  ([2bf7056](https://github.com/loro-dev/lody/commit/2bf70567f12a3663ee1d23d3407308bb995a9c8c))
- **components:** remove session sending state
  ([#710](https://github.com/loro-dev/lody/issues/710))
  ([145a671](https://github.com/loro-dev/lody/commit/145a6717c8ae94323bc85df1207bfc1929717017))
- **docker:** resolve ACP agent initialization hang in Docker mode
  ([#614](https://github.com/loro-dev/lody/issues/614))
  ([8813da5](https://github.com/loro-dev/lody/commit/8813da5ae298f6847f30772837d61377bbbf4c7f))
- **do:** prevent stale offline on reconnect
  ([#730](https://github.com/loro-dev/lody/issues/730))
  ([185c12d](https://github.com/loro-dev/lody/commit/185c12d0f05292be03382af7b967f43c26fec513))
- improve Git token handling with repo-scoped tokens and retry logic
  ([#643](https://github.com/loro-dev/lody/issues/643))
  ([a611c27](https://github.com/loro-dev/lody/commit/a611c27e7e950f4d8fa28440ccb1713d7fb8a9bb))
- keep /home as landing page
  ([#700](https://github.com/loro-dev/lody/issues/700))
  ([29251fd](https://github.com/loro-dev/lody/commit/29251fdd7025b8c4663933236143e1655df52fdc))
- open app url
  ([29251fd](https://github.com/loro-dev/lody/commit/29251fdd7025b8c4663933236143e1655df52fdc))
- rename site-url.ts to siteUrl.ts for Convex module naming compliance
  ([29251fd](https://github.com/loro-dev/lody/commit/29251fdd7025b8c4663933236143e1655df52fdc))
- request permission ([#755](https://github.com/loro-dev/lody/issues/755))
  ([c1b7fe1](https://github.com/loro-dev/lody/commit/c1b7fe1c07a9c2cffd91f65948119d0d02a91b8f))
- scope PR prompt guidance ([#631](https://github.com/loro-dev/lody/issues/631))
  ([5398b44](https://github.com/loro-dev/lody/commit/5398b444517bc71e1b20fadcb88fdc1dd6f9c4e4))
- type err
  ([27f2ba4](https://github.com/loro-dev/lody/commit/27f2ba49a67994447d525417209b203e0b43bb4d))
- websocket proxy & resume chat correctly
  ([#641](https://github.com/loro-dev/lody/issues/641))
  ([7ff2a6b](https://github.com/loro-dev/lody/commit/7ff2a6b46a2c3b12bf57bf49ed9f14270d89fae8))
- **ws:** stabilize control connection keepalive
  ([#731](https://github.com/loro-dev/lody/issues/731))
  ([df7c404](https://github.com/loro-dev/lody/commit/df7c4046cd92c833ae4753a6eaaac8efb32a58c7))

### Refactors

- move machine online/offline control to Durable Object server
  ([#635](https://github.com/loro-dev/lody/issues/635))
  ([128d2d1](https://github.com/loro-dev/lody/commit/128d2d14b125a0971d8296d4ff767f33075bc593))
- simplify do flock state update
  ([#721](https://github.com/loro-dev/lody/issues/721))
  ([d798327](https://github.com/loro-dev/lody/commit/d7983275f2dd60678ed799734ff72e4ffec95caa))

### Documentation

- add missing documentation for quickstart and docker mode
  ([#765](https://github.com/loro-dev/lody/issues/765))
  ([4c43f80](https://github.com/loro-dev/lody/commit/4c43f80706ff03cc13e8e0bf18423dd0abf67fcf))
- changelog 028 ([#771](https://github.com/loro-dev/lody/issues/771))
  ([e1a7e5e](https://github.com/loro-dev/lody/commit/e1a7e5ef2c70129f390530a0ade9c56fec08bc1f))

## [0.27.5-next.1](https://github.com/loro-dev/lody/compare/lody-cli-v0.27.4-next.1...lody-cli-v0.27.5-next.1) (2026-01-12)

### Features

- **cli:** add Claude Code ACP support and refactor plan storage
  ([#678](https://github.com/loro-dev/lody/issues/678))
  ([809e4fc](https://github.com/loro-dev/lody/commit/809e4fc3e9a58b6398de3995b24d0f20e293d7e6))
- **cli:** create PRs as GitHub user
  ([#732](https://github.com/loro-dev/lody/issues/732))
  ([4a93274](https://github.com/loro-dev/lody/commit/4a93274c3339e09f2bcb9507316df36d74f99c45))
- use user's GitHub credentials for git commits
  ([#713](https://github.com/loro-dev/lody/issues/713))
  ([974dd5b](https://github.com/loro-dev/lody/commit/974dd5ba7b36a4c7dcb530eb237d61212a668a46))

### Bug Fixes

- add clean URL rewrites for landing page docs
  ([#697](https://github.com/loro-dev/lody/issues/697))
  ([29251fd](https://github.com/loro-dev/lody/commit/29251fdd7025b8c4663933236143e1655df52fdc))
- **cli:** clear machine tombstone on reconnect to prevent stale offline status
  ([#741](https://github.com/loro-dev/lody/issues/741))
  ([466bd50](https://github.com/loro-dev/lody/commit/466bd508b00f6c1ef4a203e526efb5fc54ca4dcf))
- **cli:** ensure GitHubTokenManager never returns expired tokens
  ([#689](https://github.com/loro-dev/lody/issues/689))
  ([82f0383](https://github.com/loro-dev/lody/commit/82f03836269f4b966b949421c997698f15e894a3))
- **cli:** fix session status stuck in Running state
  ([#757](https://github.com/loro-dev/lody/issues/757))
  ([8b6bc26](https://github.com/loro-dev/lody/commit/8b6bc262887d9e1d31bd6b12e42e25b0e9b8a541))
- **cli:** normalize log output
  ([#728](https://github.com/loro-dev/lody/issues/728))
  ([35ca925](https://github.com/loro-dev/lody/commit/35ca925b43679b33042fe8994d259fa98be93448))
- **cli:** prevent session status stuck running
  ([#669](https://github.com/loro-dev/lody/issues/669))
  ([bcbb8c3](https://github.com/loro-dev/lody/commit/bcbb8c36c5a81bd43f28e3b82a8ff8aa43141ab3))
- **cli:** set session completed status and unread state immediately after
  prompt returns ([#687](https://github.com/loro-dev/lody/issues/687))
  ([acd5769](https://github.com/loro-dev/lody/commit/acd5769a4bd278eaf9dde2ae6edf88a478c554b3))
- **cli:** suppress native exec stdout logging
  ([#719](https://github.com/loro-dev/lody/issues/719))
  ([f2e475d](https://github.com/loro-dev/lody/commit/f2e475d47cee651db6efb83ea102fe8cbf86d7f4))
- **components:** remove session sending state
  ([#710](https://github.com/loro-dev/lody/issues/710))
  ([145a671](https://github.com/loro-dev/lody/commit/145a6717c8ae94323bc85df1207bfc1929717017))
- **do:** prevent stale offline on reconnect
  ([#730](https://github.com/loro-dev/lody/issues/730))
  ([185c12d](https://github.com/loro-dev/lody/commit/185c12d0f05292be03382af7b967f43c26fec513))
- keep /home as landing page
  ([#700](https://github.com/loro-dev/lody/issues/700))
  ([29251fd](https://github.com/loro-dev/lody/commit/29251fdd7025b8c4663933236143e1655df52fdc))
- open app url
  ([29251fd](https://github.com/loro-dev/lody/commit/29251fdd7025b8c4663933236143e1655df52fdc))
- rename site-url.ts to siteUrl.ts for Convex module naming compliance
  ([29251fd](https://github.com/loro-dev/lody/commit/29251fdd7025b8c4663933236143e1655df52fdc))
- **ws:** stabilize control connection keepalive
  ([#731](https://github.com/loro-dev/lody/issues/731))
  ([df7c404](https://github.com/loro-dev/lody/commit/df7c4046cd92c833ae4753a6eaaac8efb32a58c7))

### Refactors

- simplify do flock state update
  ([#721](https://github.com/loro-dev/lody/issues/721))
  ([d798327](https://github.com/loro-dev/lody/commit/d7983275f2dd60678ed799734ff72e4ffec95caa))

### Documentation

- add missing documentation for quickstart and docker mode
  ([#765](https://github.com/loro-dev/lody/issues/765))
  ([4c43f80](https://github.com/loro-dev/lody/commit/4c43f80706ff03cc13e8e0bf18423dd0abf67fcf))

## [0.27.4-next.1](https://github.com/loro-dev/lody/compare/lody-cli-v0.27.3-next.1...lody-cli-v0.27.4-next.1) (2026-01-07)

### Bug Fixes

- **cli:** avoid logging file contents in session-related logs
  ([#674](https://github.com/loro-dev/lody/issues/674))
  ([8037bf5](https://github.com/loro-dev/lody/commit/8037bf581dab532d60cfc007e19c36b531e457e4))
- **cli:** use host workdir for code-session diff in docker
  ([#671](https://github.com/loro-dev/lody/issues/671))
  ([2bf7056](https://github.com/loro-dev/lody/commit/2bf70567f12a3663ee1d23d3407308bb995a9c8c))

## [0.27.3-next.1](https://github.com/loro-dev/lody/compare/lody-cli-v0.27.2-next.1...lody-cli-v0.27.3-next.1) (2026-01-06)

### Features

- **cli:** add concurrent message processing for multiple sessions
  ([#621](https://github.com/loro-dev/lody/issues/621))
  ([16a938d](https://github.com/loro-dev/lody/commit/16a938daba951d694f1d2590bf0b8fc12349a69d))
- **cli:** add proxy support for WebSocket connections
  ([#615](https://github.com/loro-dev/lody/issues/615))
  ([b1bb613](https://github.com/loro-dev/lody/commit/b1bb613cd96c50fa07d3feeb9373f32f4f9a9900))
- **cli:** disable timestamp in log output unless --debug flag is used
  ([#616](https://github.com/loro-dev/lody/issues/616))
  ([4b90870](https://github.com/loro-dev/lody/commit/4b908707016b7ecf33f350e65565ddc3addda808))
- code session and diff files
  ([#618](https://github.com/loro-dev/lody/issues/618))
  ([6954c64](https://github.com/loro-dev/lody/commit/6954c64c7425aedd5e71540795ad99c84025bba6))
- shorten default branch name and improve branch name UX
  ([#546](https://github.com/loro-dev/lody/issues/546))
  ([1f7da89](https://github.com/loro-dev/lody/commit/1f7da8924a8a38dcfdded73001bd0064bbf5cb19))
- **web:** upgrade loro-repo to 0.10.0 and enable flock-sqlite mode
  ([#636](https://github.com/loro-dev/lody/issues/636))
  ([8347ab8](https://github.com/loro-dev/lody/commit/8347ab8d87efc359021a5ff54176354758299f23))

### Bug Fixes

- **cli:** async branch rename on session create
  ([#625](https://github.com/loro-dev/lody/issues/625))
  ([9aaa9a0](https://github.com/loro-dev/lody/commit/9aaa9a094ef0d1b3aef4a7c6de1cb0d0f43c1737))
- **cli:** translate container paths to host paths for Docker file operations
  ([#604](https://github.com/loro-dev/lody/issues/604))
  ([7598778](https://github.com/loro-dev/lody/commit/7598778b7a5475c5ebcce353bdfec4fbc5d6ae07))
- **docker:** create .cache directory with proper permissions for node user
  ([#609](https://github.com/loro-dev/lody/issues/609))
  ([97fc78d](https://github.com/loro-dev/lody/commit/97fc78df58b4b17737f61549324e2c96e93d0fa9))
- **docker:** resolve ACP agent initialization hang in Docker mode
  ([#614](https://github.com/loro-dev/lody/issues/614))
  ([8813da5](https://github.com/loro-dev/lody/commit/8813da5ae298f6847f30772837d61377bbbf4c7f))
- improve Git token handling with repo-scoped tokens and retry logic
  ([#643](https://github.com/loro-dev/lody/issues/643))
  ([a611c27](https://github.com/loro-dev/lody/commit/a611c27e7e950f4d8fa28440ccb1713d7fb8a9bb))
- scope PR prompt guidance ([#631](https://github.com/loro-dev/lody/issues/631))
  ([5398b44](https://github.com/loro-dev/lody/commit/5398b444517bc71e1b20fadcb88fdc1dd6f9c4e4))
- type err
  ([27f2ba4](https://github.com/loro-dev/lody/commit/27f2ba49a67994447d525417209b203e0b43bb4d))
- websocket proxy & resume chat correctly
  ([#641](https://github.com/loro-dev/lody/issues/641))
  ([7ff2a6b](https://github.com/loro-dev/lody/commit/7ff2a6b46a2c3b12bf57bf49ed9f14270d89fae8))

### Refactors

- move machine online/offline control to Durable Object server
  ([#635](https://github.com/loro-dev/lody/issues/635))
  ([128d2d1](https://github.com/loro-dev/lody/commit/128d2d14b125a0971d8296d4ff767f33075bc593))

## [0.27.0](https://github.com/loro-dev/lody/compare/lody-cli-v0.26.0...lody-cli-v0.27.0) (2025-12-31)

### Features

- add message queue for queueing messages while agent is running
  ([#548](https://github.com/loro-dev/lody/issues/548))
  ([c00b698](https://github.com/loro-dev/lody/commit/c00b698099736f7f740ee7008e1bf4bf59beb932))
- code diff ([#569](https://github.com/loro-dev/lody/issues/569))
  ([d7befef](https://github.com/loro-dev/lody/commit/d7befefc625003e386942f0edba81c238490f535))
- **components:** add Copy Chat as Markdown button
  ([#552](https://github.com/loro-dev/lody/issues/552))
  ([0587849](https://github.com/loro-dev/lody/commit/05878495e6f8f62dbcd79cd5bd9d75109a20c44c))
- optimize user onboarding flow
  ([#550](https://github.com/loro-dev/lody/issues/550))
  ([17da57b](https://github.com/loro-dev/lody/commit/17da57bbbfff5c15bb28ec0dbfa1a37ab729d976))
- send push notification to message sender instead of CLI user
  ([#551](https://github.com/loro-dev/lody/issues/551))
  ([2698bfe](https://github.com/loro-dev/lody/commit/2698bfe9357780f574f8a9c0ebaced8c953c6fa6))
- **ui:** add typing indicator animation when agent is running
  ([#562](https://github.com/loro-dev/lody/issues/562))
  ([138b131](https://github.com/loro-dev/lody/commit/138b131032a9f3e43bbf4487806a87265f02f9b7))

### Bug Fixes

- **cli:** docker ACP resume fallback
  ([#542](https://github.com/loro-dev/lody/issues/542))
  ([7f85b66](https://github.com/loro-dev/lody/commit/7f85b668ff2b6e7bc2366a8456c7ca05c4651891))
- **cli:** translate container paths to host paths for Docker file operations
  ([#604](https://github.com/loro-dev/lody/issues/604))
  ([7598778](https://github.com/loro-dev/lody/commit/7598778b7a5475c5ebcce353bdfec4fbc5d6ae07))

### Refactors

- move OneSignal push notifications from CLI to Convex
  ([#547](https://github.com/loro-dev/lody/issues/547))
  ([28e64fe](https://github.com/loro-dev/lody/commit/28e64fe1089350ca99fe1a637686e2b7234f2e01))
- remove workspace doc remnants
  ([1f8de9d](https://github.com/loro-dev/lody/commit/1f8de9d32f528185d0f2a830a361684f00b8fa96))

## [0.27.2-next.1](https://github.com/loro-dev/lody/compare/lody-cli-v0.27.1-next.1...lody-cli-v0.27.2-next.1) (2025-12-30)

### Features

- add message queue for queueing messages while agent is running
  ([#548](https://github.com/loro-dev/lody/issues/548))
  ([c00b698](https://github.com/loro-dev/lody/commit/c00b698099736f7f740ee7008e1bf4bf59beb932))
- code diff ([#569](https://github.com/loro-dev/lody/issues/569))
  ([d7befef](https://github.com/loro-dev/lody/commit/d7befefc625003e386942f0edba81c238490f535))
- **components:** add Copy Chat as Markdown button
  ([#552](https://github.com/loro-dev/lody/issues/552))
  ([0587849](https://github.com/loro-dev/lody/commit/05878495e6f8f62dbcd79cd5bd9d75109a20c44c))
- **ui:** add typing indicator animation when agent is running
  ([#562](https://github.com/loro-dev/lody/issues/562))
  ([138b131](https://github.com/loro-dev/lody/commit/138b131032a9f3e43bbf4487806a87265f02f9b7))

## [0.27.1-next.1](https://github.com/loro-dev/lody/compare/lody-cli-v0.27.0-next.1...lody-cli-v0.27.1-next.1) (2025-12-29)

### Features

- **acp-history:** persist codex command output as terminal blocks
  ([df4e231](https://github.com/loro-dev/lody/commit/df4e231908092ecff7c7c3026f37ed95565a2cde))
- Add `supportCliTypes` to machine metadata and filter agent selections by
  supported CLI types. ([#369](https://github.com/loro-dev/lody/issues/369))
  ([93ffef1](https://github.com/loro-dev/lody/commit/93ffef17aa67dedd39b5599805ebcf802a49800a))
- add acp model mode history & add e2e test
  ([#422](https://github.com/loro-dev/lody/issues/422))
  ([94072da](https://github.com/loro-dev/lody/commit/94072da2470b78eda9e1c8db1f8a08bbb2eb5e9d))
- add command output to history
  ([1fe2009](https://github.com/loro-dev/lody/commit/1fe20095008ff9173f3f3db3586d508d9eff6d0b))
- Add Git credential helper and GitHub token management for CLI.
  ([5b922a5](https://github.com/loro-dev/lody/commit/5b922a5822c3ec7d9c3fd1e525ec7b70bd797838))
- add machine mode support ([#251](https://github.com/loro-dev/lody/issues/251))
  ([dc39fe9](https://github.com/loro-dev/lody/commit/dc39fe9cb2228f39b5393ce0bb5113fbaa0e83e3))
- add pr webhook reporting and show PR info
  ([#267](https://github.com/loro-dev/lody/issues/267))
  ([0fb67d0](https://github.com/loro-dev/lody/commit/0fb67d0ba0ad4f5299307d8d4d465b669a807a1d))
- add reconnect logic and event handlers for WebSocket connections
  ([#207](https://github.com/loro-dev/lody/issues/207))
  ([f6c823c](https://github.com/loro-dev/lody/commit/f6c823c615c6623992db953d13cac90a6a85fe0d))
- add user metadata to session history
  ([3b54339](https://github.com/loro-dev/lody/commit/3b54339f4796f06c7a8121dcebd275f5b7c6c42b))
- agent config meta
  ([2d8afe4](https://github.com/loro-dev/lody/commit/2d8afe4c53f30417367fb2cc86fd051d31a9998c))
- align pr session association
  ([#368](https://github.com/loro-dev/lody/issues/368))
  ([8786bf8](https://github.com/loro-dev/lody/commit/8786bf8c05a476a0a9e9d0e9c486dacc25505f38))
- associate sessions with pull requests
  ([#444](https://github.com/loro-dev/lody/issues/444))
  ([724badf](https://github.com/loro-dev/lody/commit/724badfdaada1a247b76511a982801841954c5ca))
- cli loro repo
  ([f89ba5b](https://github.com/loro-dev/lody/commit/f89ba5b63da0b3d03d42d7bc1ff8757a20fcb38a))
- **cli:** auto-generate meaningful branch names when creating PRs
  ([#521](https://github.com/loro-dev/lody/issues/521))
  ([35ea76a](https://github.com/loro-dev/lody/commit/35ea76ae926501e359847ff6ab37a53f6cdcf814))
- **components:** persist chat landing defaults
  ([#403](https://github.com/loro-dev/lody/issues/403))
  ([bcebd48](https://github.com/loro-dev/lody/commit/bcebd486274c13b9a0da7f1d0309ef711ecfd871))
- **components:** sidebar ([#357](https://github.com/loro-dev/lody/issues/357))
  ([eea270e](https://github.com/loro-dev/lody/commit/eea270e99f81a7de6f1d0250199d9fcce17ca89d))
- ensure Lody's helper is prioritized by clearing existing ones.
  ([#439](https://github.com/loro-dev/lody/issues/439))
  ([e770edc](https://github.com/loro-dev/lody/commit/e770edcf931aeefebced84a4ac254642a862afd9))
- eph machine
  ([c35a894](https://github.com/loro-dev/lody/commit/c35a894d0b6685f5cb08cca75be50e2fe6771496))
- Generate session titles via local agent on remote creates
  ([#270](https://github.com/loro-dev/lody/issues/270))
  ([0be87f4](https://github.com/loro-dev/lody/commit/0be87f428f5227b91e1b7b2b8b340b61afcd1724))
- gh token
  ([7f86f8b](https://github.com/loro-dev/lody/commit/7f86f8b55d436cadc11d47ea3f7eaad4fe3a67c4))
- Implement and integrate a new session status state machine with validation and
  new statuses.
  ([97da3d0](https://github.com/loro-dev/lody/commit/97da3d08fb479286913e0ecf8f6c9c06d1afd1ab))
- implement external chat history resume fallback
  ([#534](https://github.com/loro-dev/lody/issues/534))
  ([8bbacec](https://github.com/loro-dev/lody/commit/8bbacecea3032eb1291d2a2c94e7044fef00b466))
- Implement session archiving
  ([#379](https://github.com/loro-dev/lody/issues/379))
  ([1a1ba8a](https://github.com/loro-dev/lody/commit/1a1ba8ae355b5800504724f1a73c92344b8518ed))
- introduce 'created' session status as initial state, replacing 'establish' and
  adjusting related logic and translations.
  ([a3aad2f](https://github.com/loro-dev/lody/commit/a3aad2fb350d3ddd4481ebc982e562383faaed5e))
- introduce LODY_USER_ID and update issue action handling
  ([f485957](https://github.com/loro-dev/lody/commit/f485957e3d327da78f9be7813d444a9cc2391819))
- invite-code beta gate ([#472](https://github.com/loro-dev/lody/issues/472))
  ([83947a2](https://github.com/loro-dev/lody/commit/83947a2d57d6841c430914dfa29a4267d63f0831))
- loro repo
  ([3fbba87](https://github.com/loro-dev/lody/commit/3fbba8755be5321db28ed47ae6d893b4202315b6))
- loro repo issue meta
  ([3c01b46](https://github.com/loro-dev/lody/commit/3c01b4662925973fd0adfbea9d2c054ad06e5eea))
- machine meta
  ([a7dc15a](https://github.com/loro-dev/lody/commit/a7dc15a168dca138d818312cef03d5c71e0b8c86))
- machine meta
  ([2e3620f](https://github.com/loro-dev/lody/commit/2e3620f22e899d8556e3648461ecd763182f4610))
- model mode selector ([#381](https://github.com/loro-dev/lody/issues/381))
  ([c080efc](https://github.com/loro-dev/lody/commit/c080efc10ef12dbe4bd9b67f3ed3cbb33a3f7a60))
- optimize user onboarding flow
  ([#550](https://github.com/loro-dev/lody/issues/550))
  ([17da57b](https://github.com/loro-dev/lody/commit/17da57bbbfff5c15bb28ec0dbfa1a37ab729d976))
- remove codex and claude CLI commands
  ([#348](https://github.com/loro-dev/lody/issues/348))
  ([4e54b0f](https://github.com/loro-dev/lody/commit/4e54b0f36896babce03218bba6ca62caf724eba7))
- resume chat after closed session
  ([#506](https://github.com/loro-dev/lody/issues/506))
  ([0b4b388](https://github.com/loro-dev/lody/commit/0b4b3884a550fd68997a3a830e45d21baa26a910))
- send onesignal push on session completion
  ([#528](https://github.com/loro-dev/lody/issues/528))
  ([328285d](https://github.com/loro-dev/lody/commit/328285d12287f7f30c5242ca3ab969e7fb6bd1be))
- send push notification to message sender instead of CLI user
  ([#551](https://github.com/loro-dev/lody/issues/551))
  ([2698bfe](https://github.com/loro-dev/lody/commit/2698bfe9357780f574f8a9c0ebaced8c953c6fa6))
- session state machine
  ([4925a33](https://github.com/loro-dev/lody/commit/4925a33cf30ac76eae52b205baea4325e47d9047))
- single Docker container per repo
  ([#264](https://github.com/loro-dev/lody/issues/264))
  ([b5b4327](https://github.com/loro-dev/lody/commit/b5b4327f57cf6ae5457312b3f8e0d89eafa3e032))
- state machine
  ([479c21c](https://github.com/loro-dev/lody/commit/479c21c71d0b67282a9767c999d8c07df72cd0a9))
- sync and display ACP plan
  ([#316](https://github.com/loro-dev/lody/issues/316))
  ([d8fc433](https://github.com/loro-dev/lody/commit/d8fc433c4d5669a080f863b8651d9aec3ecab39c))
- sync session startup progress
  ([#296](https://github.com/loro-dev/lody/issues/296))
  ([9620f05](https://github.com/loro-dev/lody/commit/9620f055aa741f97fd7fa17b1d0c67429b38089c))
- test ci
  ([9556569](https://github.com/loro-dev/lody/commit/955656924e904546ec062f8d8daec090ee10cd73))

### Bug Fixes

- fix:
  ([898c76d](https://github.com/loro-dev/lody/commit/898c76d84673c4686e9e106aaa5a98107608b54f))
- fix:
  ([955040d](https://github.com/loro-dev/lody/commit/955040dc6f27ca70bac2cf07a2c5b185ad9cd941))
- add debug logging for session read state
  ([c12cf2a](https://github.com/loro-dev/lody/commit/c12cf2a5db1802aba76dcfadb3242ce19d6cec51))
- add log about the content failed to parse
  ([#258](https://github.com/loro-dev/lody/issues/258))
  ([da70da3](https://github.com/loro-dev/lody/commit/da70da3c36e2c75f55a336eeab3279edd110ad57))
- agent thought
  ([d601320](https://github.com/loro-dev/lody/commit/d601320cec202fab5d4c8bbedd1c7b81616db542))
- background ([#231](https://github.com/loro-dev/lody/issues/231))
  ([63a6f32](https://github.com/loro-dev/lody/commit/63a6f326b271cce0d2cbb37dccf3924d076b6e73))
- chat ui ([#321](https://github.com/loro-dev/lody/issues/321))
  ([a7caa4b](https://github.com/loro-dev/lody/commit/a7caa4bdef3aa15ae98d648c434b01eaa1134a4c))
- cli
  ([532ca8d](https://github.com/loro-dev/lody/commit/532ca8db961df2186c6048547b5849da51ea9b6f))
- cli __filename
  ([fa7f07e](https://github.com/loro-dev/lody/commit/fa7f07ea91f29ddab2bc35e07d2f645f911e3b1d))
- cli __filename
  ([e58f121](https://github.com/loro-dev/lody/commit/e58f1214090438b6c431072adce76f5d39c1d9ab))
- cli cc codex
  ([bb878af](https://github.com/loro-dev/lody/commit/bb878af3a55f514c545bcdcf9d8b22402e1c1fc5))
- cli env
  ([dcc5c06](https://github.com/loro-dev/lody/commit/dcc5c069d7543d7f06694e3847dcf8f89a38505b))
- **cli:** auto-mark latest user history as read
  ([#387](https://github.com/loro-dev/lody/issues/387))
  ([eac5061](https://github.com/loro-dev/lody/commit/eac50614598d4dd8193de3cc5814a2869155ca15))
- **cli:** base worktrees on origin/main
  ([#352](https://github.com/loro-dev/lody/issues/352))
  ([740ce40](https://github.com/loro-dev/lody/commit/740ce4078caf923f09f1a86b6ea491b819661dda))
- **cli:** clarify gh pr body formatting instruction
  ([#525](https://github.com/loro-dev/lody/issues/525))
  ([54baa7e](https://github.com/loro-dev/lody/commit/54baa7e5369de28e26a16427e536d297d28395fa))
- **cli:** clarify gh pr body newlines
  ([#401](https://github.com/loro-dev/lody/issues/401))
  ([803a240](https://github.com/loro-dev/lody/commit/803a24061b2b1b139f516103398d30d1f79eb9b4))
- **cli:** compact session history tool payloads
  ([#497](https://github.com/loro-dev/lody/issues/497))
  ([e2f18da](https://github.com/loro-dev/lody/commit/e2f18da1f7f5077f22cabfeca6602ae91ec45bc0))
- **cli:** dedupe replayed thought chunks in history
  ([#314](https://github.com/loro-dev/lody/issues/314))
  ([468f533](https://github.com/loro-dev/lody/commit/468f53382de63f6f2723e7357db3655322fa7f10))
- **cli:** default start to foreground
  ([#469](https://github.com/loro-dev/lody/issues/469))
  ([1cedb8a](https://github.com/loro-dev/lody/commit/1cedb8a1c4fce67a055bb7ab959f869d01c074bd))
- **cli:** disable terminal capability in title agent
  ([#523](https://github.com/loro-dev/lody/issues/523))
  ([d19d2a0](https://github.com/loro-dev/lody/commit/d19d2a037debf8b11bb4de0c1232014226372b2d))
- **cli:** docker ACP resume fallback
  ([#542](https://github.com/loro-dev/lody/issues/542))
  ([7f85b66](https://github.com/loro-dev/lody/commit/7f85b668ff2b6e7bc2366a8456c7ca05c4651891))
- **cli:** don't hard-exit on unhandledRejection
  ([#318](https://github.com/loro-dev/lody/issues/318))
  ([77ed07f](https://github.com/loro-dev/lody/commit/77ed07fb21f457ceae84685f9c022b656ee20a41))
- **cli:** group agent turn into single history item
  ([#297](https://github.com/loro-dev/lody/issues/297))
  ([af803a8](https://github.com/loro-dev/lody/commit/af803a8831436326fc1eb79b6ef3e08cd6ee4d52))
- **cli:** improve object logging
  ([c34a1cf](https://github.com/loro-dev/lody/commit/c34a1cf7be0005bcb41e51e4211b63c610c7dc53))
- **cli:** improve object logging
  ([8f62b63](https://github.com/loro-dev/lody/commit/8f62b63028fea36e48ddb4ea2e45fbbbd4c68d29))
- **cli:** prevent startup hang on firstSyncedWithRemote
  ([#532](https://github.com/loro-dev/lody/issues/532))
  ([956cb28](https://github.com/loro-dev/lody/commit/956cb2877190a4fae79afc218c9a129d6aa5e2ad))
- **cli:** prevent title agent git repo warning
  ([#499](https://github.com/loro-dev/lody/issues/499))
  ([14ac219](https://github.com/loro-dev/lody/commit/14ac219386ab642025706a6af8b514fa77f5f419))
- **cli:** print happy coding message after machine registration
  ([#500](https://github.com/loro-dev/lody/issues/500))
  ([02047e1](https://github.com/loro-dev/lody/commit/02047e1509ea2e201bf6a7664da213d5a27aae99))
- **cli:** remove duplicate code in handleSessionChat
  ([#535](https://github.com/loro-dev/lody/issues/535))
  ([f7d6dd5](https://github.com/loro-dev/lody/commit/f7d6dd53bb316cf38b17ae8accaef9956a849edb))
- **cli:** require plain-text session titles
  ([#310](https://github.com/loro-dev/lody/issues/310))
  ([d9e1d5f](https://github.com/loro-dev/lody/commit/d9e1d5f652a69d56a9f3e163fd970947aa590f32))
- **cli:** reset machine_disconnected sessions on reconnect
  ([#359](https://github.com/loro-dev/lody/issues/359))
  ([db7428c](https://github.com/loro-dev/lody/commit/db7428c437ea9222b2bbd04e42e858215591508b))
- **cli:** restore soft-deleted machine doc
  ([#392](https://github.com/loro-dev/lody/issues/392))
  ([ede42f5](https://github.com/loro-dev/lody/commit/ede42f55d72fdaa0a4e46a77a4241290a3a59047))
- **cli:** skip github helper for non-github remotes
  ([81d7c44](https://github.com/loro-dev/lody/commit/81d7c446a1a0c4f654e2e26d1726c10f86ac0580))
- **cli:** support LODY_REPOS_DIR
  ([eac059b](https://github.com/loro-dev/lody/commit/eac059b0b749fe64fc14ebb3325a6c9bd5366ef5))
- **cli:** sync git branch name into session meta
  ([#390](https://github.com/loro-dev/lody/issues/390))
  ([08b89bf](https://github.com/loro-dev/lody/commit/08b89bf72322f01136b0447cca5afcd87336b0d1))
- do
  ([38081bf](https://github.com/loro-dev/lody/commit/38081bff528329d883802ac315c2eafc9b38feb2))
- don't need to append pr prompt for each message
  ([2195eb1](https://github.com/loro-dev/lody/commit/2195eb1d840cac56540598df3cc60facba3aefd4))
- eph
  ([8cc43bb](https://github.com/loro-dev/lody/commit/8cc43bb1650727fec87df479ff664cba8e807b11))
- eph err
  ([c3e369d](https://github.com/loro-dev/lody/commit/c3e369d98d3bb43b1132508ccf012ea5a0958d55))
- error
  ([2f9c891](https://github.com/loro-dev/lody/commit/2f9c891564295dfcc4d4998f51a9ede52a5e9fb5))
- find machine by id in do
  ([3a0fbe1](https://github.com/loro-dev/lody/commit/3a0fbe1cd72fa095f90d69bf257d8fd9ca4e5a27))
- gh wrapper ([#360](https://github.com/loro-dev/lody/issues/360))
  ([439784f](https://github.com/loro-dev/lody/commit/439784fe4d21fa154a9585fbba0b5840d72e916f))
- improve error handling and avoid process being undefined
  ([ceb3939](https://github.com/loro-dev/lody/commit/ceb3939743ae193ae55949bc36ccc484d658def8))
- improve GitHubTokenManager logic
  ([#435](https://github.com/loro-dev/lody/issues/435))
  ([1443c2a](https://github.com/loro-dev/lody/commit/1443c2a604d4385e4b0a884408fe81233775bb17))
- let CLI generate session titles
  ([#291](https://github.com/loro-dev/lody/issues/291))
  ([fb01429](https://github.com/loro-dev/lody/commit/fb01429e46c7a16b9eb0b7aa7a604d38e73286bc))
- Linux Docker git auth PRD
  ([#480](https://github.com/loro-dev/lody/issues/480))
  ([495d374](https://github.com/loro-dev/lody/commit/495d374108fcf3cba1a416dbb8775fa354e2fe65))
- machine reconnect register
  ([b03f088](https://github.com/loro-dev/lody/commit/b03f0884f0b01c1f43caeea2adc1506cb5736b01))
- make cli type safer ([#249](https://github.com/loro-dev/lody/issues/249))
  ([673bded](https://github.com/loro-dev/lody/commit/673bded1c7ba9403b4d9b84c67aaf5d6739a43c3))
- mark msg as read as soon as received new session doc
  ([#399](https://github.com/loro-dev/lody/issues/399))
  ([35f7550](https://github.com/loro-dev/lody/commit/35f75504da8015736bc2fbf65742f19948164ea8))
- mark terminated machine sessions correctly
  ([#242](https://github.com/loro-dev/lody/issues/242))
  ([c8504bc](https://github.com/loro-dev/lody/commit/c8504bca422a2ceddcd08d129a4bfb96742a0e43))
- merge
  ([8a56f30](https://github.com/loro-dev/lody/commit/8a56f30edf707163ae94b7635c424e833f4db26a))
- module
  ([c5fb124](https://github.com/loro-dev/lody/commit/c5fb12412cc2586b006bfdd0bd4d0943fe7915db))
- never destroy sub
  ([ded2407](https://github.com/loro-dev/lody/commit/ded24071742ebe062a5c6a620a2ea6f50f8e8cd0))
- prevent uncaught ws error crash
  ([#265](https://github.com/loro-dev/lody/issues/265))
  ([1ae60e5](https://github.com/loro-dev/lody/commit/1ae60e575575133df96074cedafdaa6c0a310a3f))
- re-register machine after reconnect
  ([#266](https://github.com/loro-dev/lody/issues/266))
  ([7b5eba7](https://github.com/loro-dev/lody/commit/7b5eba7a9d4526616f68e060d8220d925fe14f91))
- refine title gen and session start process
  ([#294](https://github.com/loro-dev/lody/issues/294))
  ([37a5504](https://github.com/loro-dev/lody/commit/37a550450833910ed33b0a0c084aa523f009d20c))
- release
  ([4a31721](https://github.com/loro-dev/lody/commit/4a317214c4c3f6568202186976801a82bf7de25b))
- repo
  ([13712c0](https://github.com/loro-dev/lody/commit/13712c0fbd61c5b196e334138a62ab211ceabe54))
- require CLI ack for session create
  ([#498](https://github.com/loro-dev/lody/issues/498))
  ([42df83d](https://github.com/loro-dev/lody/commit/42df83dc33083039156cfd2be8fadbe8fe1f86c1))
- sentry
  ([6826e62](https://github.com/loro-dev/lody/commit/6826e622d05173dc73b8cbff576efadc79438005))
- sentry do not need in cli
  ([d16d29d](https://github.com/loro-dev/lody/commit/d16d29d350bfd2c81b37ba03c83a01a0c98b3353))
- session history be overwritten
  ([#234](https://github.com/loro-dev/lody/issues/234))
  ([5b0b63a](https://github.com/loro-dev/lody/commit/5b0b63a30ce11f283398a674614d36adcaa4ac26))
- sessions loading and syncing issues
  ([#378](https://github.com/loro-dev/lody/issues/378))
  ([5ebe050](https://github.com/loro-dev/lody/commit/5ebe050a934428b8dfc9d4216ca39b23fb9b5ba8))
- short title ([#330](https://github.com/loro-dev/lody/issues/330))
  ([eec0acc](https://github.com/loro-dev/lody/commit/eec0acc51bfb509d4323a093c0103792241fe476))
- stop org retry on missing member
  ([#518](https://github.com/loro-dev/lody/issues/518))
  ([bb762c6](https://github.com/loro-dev/lody/commit/bb762c6db16adf1cdd69846ca7bc3f53ba219dee))
- switch to git-credential auth
  ([92a30ba](https://github.com/loro-dev/lody/commit/92a30ba6614de76cc4ab44c18a212f56e702565c))
- Track session read status with message timestamps
  ([#413](https://github.com/loro-dev/lody/issues/413))
  ([1a5cbe7](https://github.com/loro-dev/lody/commit/1a5cbe709426615d0d2a2b7a52dabbaf2f3cdbe7))
- user chat
  ([ee244ff](https://github.com/loro-dev/lody/commit/ee244ff9e7f1e03cf465563d0a3d1062007e9eac))
- watch machine meta for soft delete
  ([#400](https://github.com/loro-dev/lody/issues/400))
  ([331bd82](https://github.com/loro-dev/lody/commit/331bd8280042f89ac9cfc0c1f6be57e89737d800))
- worktree dir issue ([#288](https://github.com/loro-dev/lody/issues/288))
  ([dec7e2d](https://github.com/loro-dev/lody/commit/dec7e2d085df7ef90fd3126f92224c55695f89e9))
- ws message type
  ([d17e835](https://github.com/loro-dev/lody/commit/d17e835abcfc7827c654107764b59307d9ae9789))
- zod is too strict for message content
  ([#260](https://github.com/loro-dev/lody/issues/260))
  ([b312f6f](https://github.com/loro-dev/lody/commit/b312f6f5f77ea54f45cc43c803b82a384501de8a))

### Performance

- **cli:** start ACP from bundled deps
  ([#483](https://github.com/loro-dev/lody/issues/483))
  ([45f0e89](https://github.com/loro-dev/lody/commit/45f0e89318e13fdc498db1fbb7c6c4548d4dc972))
- speedup applyMessageContents in handle acp update message
  ([#256](https://github.com/loro-dev/lody/issues/256))
  ([a052d3d](https://github.com/loro-dev/lody/commit/a052d3d9e7da3295831a0056417b8dbd2dac9e64))

### Refactors

- make cli testable and fix title extract logics
  ([af85e30](https://github.com/loro-dev/lody/commit/af85e3081cbe6128ef41f2027a237e50cfc6a303))
- migrate loro-mirror history schema to use Any items
  ([fdb3bb1](https://github.com/loro-dev/lody/commit/fdb3bb1a34862799b463d402e838647f3527d8ab))
- move OneSignal push notifications from CLI to Convex
  ([#547](https://github.com/loro-dev/lody/issues/547))
  ([28e64fe](https://github.com/loro-dev/lody/commit/28e64fe1089350ca99fe1a637686e2b7234f2e01))
- refactor and optimize frontend
  ([#345](https://github.com/loro-dev/lody/issues/345))
  ([3ba2392](https://github.com/loro-dev/lody/commit/3ba2392f38a53d30871a83795c3cd1c3d17dade0))
- remove createdAt from session heartbeat
  ([93ea4fe](https://github.com/loro-dev/lody/commit/93ea4fed61ddd9d2c9715056ff7b453a4164b57c))
- remove error handling from ephemeral session updates and streamline session
  management
  ([17e11df](https://github.com/loro-dev/lody/commit/17e11dfc3eec63d1ee05ffd20cc4325fff802956))
- remove workspace doc remnants
  ([1f8de9d](https://github.com/loro-dev/lody/commit/1f8de9d32f528185d0f2a830a361684f00b8fa96))
- simplify git credential handling
  ([8bbfc6d](https://github.com/loro-dev/lody/commit/8bbfc6d57e9f40df12a484e6bf61fc59bb5def93))
- Simplify GitHub token management by removing the `isPrivate` flag and adding
  tests.
  ([9b579e9](https://github.com/loro-dev/lody/commit/9b579e9ce126847f28f987250636b30e225e5f40))
- standardize session error handling and update error codes
  ([128a1f9](https://github.com/loro-dev/lody/commit/128a1f99f4344e4e4ed9bcb2be81bc51036451ef))
- update logging and registration logic in agent-client and message-handler
  ([7c248a2](https://github.com/loro-dev/lody/commit/7c248a21f3d10d135bed1c862b8841e350206eb9))

## [0.26.0](https://github.com/loro-dev/lody/compare/lody-cli-v0.25.0...lody-cli-v0.26.0) (2025-12-28)

### Features

- **cli:** auto-generate meaningful branch names when creating PRs
  ([#521](https://github.com/loro-dev/lody/issues/521))
  ([35ea76a](https://github.com/loro-dev/lody/commit/35ea76ae926501e359847ff6ab37a53f6cdcf814))
- implement external chat history resume fallback
  ([#534](https://github.com/loro-dev/lody/issues/534))
  ([8bbacec](https://github.com/loro-dev/lody/commit/8bbacecea3032eb1291d2a2c94e7044fef00b466))
- resume chat after closed session
  ([#506](https://github.com/loro-dev/lody/issues/506))
  ([0b4b388](https://github.com/loro-dev/lody/commit/0b4b3884a550fd68997a3a830e45d21baa26a910))
- send onesignal push on session completion
  ([#528](https://github.com/loro-dev/lody/issues/528))
  ([328285d](https://github.com/loro-dev/lody/commit/328285d12287f7f30c5242ca3ab969e7fb6bd1be))

### Bug Fixes

- **cli:** clarify gh pr body formatting instruction
  ([#525](https://github.com/loro-dev/lody/issues/525))
  ([54baa7e](https://github.com/loro-dev/lody/commit/54baa7e5369de28e26a16427e536d297d28395fa))
- **cli:** compact session history tool payloads
  ([#497](https://github.com/loro-dev/lody/issues/497))
  ([e2f18da](https://github.com/loro-dev/lody/commit/e2f18da1f7f5077f22cabfeca6602ae91ec45bc0))
- **cli:** disable terminal capability in title agent
  ([#523](https://github.com/loro-dev/lody/issues/523))
  ([d19d2a0](https://github.com/loro-dev/lody/commit/d19d2a037debf8b11bb4de0c1232014226372b2d))
- **cli:** prevent startup hang on firstSyncedWithRemote
  ([#532](https://github.com/loro-dev/lody/issues/532))
  ([956cb28](https://github.com/loro-dev/lody/commit/956cb2877190a4fae79afc218c9a129d6aa5e2ad))
- **cli:** remove duplicate code in handleSessionChat
  ([#535](https://github.com/loro-dev/lody/issues/535))
  ([f7d6dd5](https://github.com/loro-dev/lody/commit/f7d6dd53bb316cf38b17ae8accaef9956a849edb))
- stop org retry on missing member
  ([#518](https://github.com/loro-dev/lody/issues/518))
  ([bb762c6](https://github.com/loro-dev/lody/commit/bb762c6db16adf1cdd69846ca7bc3f53ba219dee))

## [0.25.0](https://github.com/loro-dev/lody/compare/lody-cli-v0.24.0...lody-cli-v0.25.0) (2025-12-27)

### Features

- acp
  ([fc0b287](https://github.com/loro-dev/lody/commit/fc0b28764ff8bfe3c38aae10274afa5a1e69d675))
- **acp-history:** persist codex command output as terminal blocks
  ([df4e231](https://github.com/loro-dev/lody/commit/df4e231908092ecff7c7c3026f37ed95565a2cde))
- Add `supportCliTypes` to machine metadata and filter agent selections by
  supported CLI types. ([#369](https://github.com/loro-dev/lody/issues/369))
  ([93ffef1](https://github.com/loro-dev/lody/commit/93ffef17aa67dedd39b5599805ebcf802a49800a))
- add acp model mode history & add e2e test
  ([#422](https://github.com/loro-dev/lody/issues/422))
  ([94072da](https://github.com/loro-dev/lody/commit/94072da2470b78eda9e1c8db1f8a08bbb2eb5e9d))
- add command output to history
  ([1fe2009](https://github.com/loro-dev/lody/commit/1fe20095008ff9173f3f3db3586d508d9eff6d0b))
- Add Git credential helper and GitHub token management for CLI.
  ([5b922a5](https://github.com/loro-dev/lody/commit/5b922a5822c3ec7d9c3fd1e525ec7b70bd797838))
- add machine mode support ([#251](https://github.com/loro-dev/lody/issues/251))
  ([dc39fe9](https://github.com/loro-dev/lody/commit/dc39fe9cb2228f39b5393ce0bb5113fbaa0e83e3))
- add pr webhook reporting and show PR info
  ([#267](https://github.com/loro-dev/lody/issues/267))
  ([0fb67d0](https://github.com/loro-dev/lody/commit/0fb67d0ba0ad4f5299307d8d4d465b669a807a1d))
- add reconnect logic and event handlers for WebSocket connections
  ([#207](https://github.com/loro-dev/lody/issues/207))
  ([f6c823c](https://github.com/loro-dev/lody/commit/f6c823c615c6623992db953d13cac90a6a85fe0d))
- add session creation dialog 6866ca44
  ([4706b05](https://github.com/loro-dev/lody/commit/4706b0595c4a03138081e73af26d24a172cdf6b0))
- add user metadata to session history
  ([3b54339](https://github.com/loro-dev/lody/commit/3b54339f4796f06c7a8121dcebd275f5b7c6c42b))
- agent config meta
  ([2d8afe4](https://github.com/loro-dev/lody/commit/2d8afe4c53f30417367fb2cc86fd051d31a9998c))
- align pr session association
  ([#368](https://github.com/loro-dev/lody/issues/368))
  ([8786bf8](https://github.com/loro-dev/lody/commit/8786bf8c05a476a0a9e9d0e9c486dacc25505f38))
- associate sessions with pull requests
  ([#444](https://github.com/loro-dev/lody/issues/444))
  ([724badf](https://github.com/loro-dev/lody/commit/724badfdaada1a247b76511a982801841954c5ca))
- cli loro repo
  ([f89ba5b](https://github.com/loro-dev/lody/commit/f89ba5b63da0b3d03d42d7bc1ff8757a20fcb38a))
- **components:** persist chat landing defaults
  ([#403](https://github.com/loro-dev/lody/issues/403))
  ([bcebd48](https://github.com/loro-dev/lody/commit/bcebd486274c13b9a0da7f1d0309ef711ecfd871))
- **components:** sidebar ([#357](https://github.com/loro-dev/lody/issues/357))
  ([eea270e](https://github.com/loro-dev/lody/commit/eea270e99f81a7de6f1d0250199d9fcce17ca89d))
- ensure Lody's helper is prioritized by clearing existing ones.
  ([#439](https://github.com/loro-dev/lody/issues/439))
  ([e770edc](https://github.com/loro-dev/lody/commit/e770edcf931aeefebced84a4ac254642a862afd9))
- eph machine
  ([c35a894](https://github.com/loro-dev/lody/commit/c35a894d0b6685f5cb08cca75be50e2fe6771496))
- Generate session titles via local agent on remote creates
  ([#270](https://github.com/loro-dev/lody/issues/270))
  ([0be87f4](https://github.com/loro-dev/lody/commit/0be87f428f5227b91e1b7b2b8b340b61afcd1724))
- gh token
  ([7f86f8b](https://github.com/loro-dev/lody/commit/7f86f8b55d436cadc11d47ea3f7eaad4fe3a67c4))
- Implement and integrate a new session status state machine with validation and
  new statuses.
  ([97da3d0](https://github.com/loro-dev/lody/commit/97da3d08fb479286913e0ecf8f6c9c06d1afd1ab))
- Implement session archiving
  ([#379](https://github.com/loro-dev/lody/issues/379))
  ([1a1ba8a](https://github.com/loro-dev/lody/commit/1a1ba8ae355b5800504724f1a73c92344b8518ed))
- introduce 'created' session status as initial state, replacing 'establish' and
  adjusting related logic and translations.
  ([a3aad2f](https://github.com/loro-dev/lody/commit/a3aad2fb350d3ddd4481ebc982e562383faaed5e))
- introduce LODY_USER_ID and update issue action handling
  ([f485957](https://github.com/loro-dev/lody/commit/f485957e3d327da78f9be7813d444a9cc2391819))
- invite-code beta gate ([#472](https://github.com/loro-dev/lody/issues/472))
  ([83947a2](https://github.com/loro-dev/lody/commit/83947a2d57d6841c430914dfa29a4267d63f0831))
- loro repo
  ([3fbba87](https://github.com/loro-dev/lody/commit/3fbba8755be5321db28ed47ae6d893b4202315b6))
- loro repo issue meta
  ([3c01b46](https://github.com/loro-dev/lody/commit/3c01b4662925973fd0adfbea9d2c054ad06e5eea))
- machine meta
  ([a7dc15a](https://github.com/loro-dev/lody/commit/a7dc15a168dca138d818312cef03d5c71e0b8c86))
- machine meta
  ([2e3620f](https://github.com/loro-dev/lody/commit/2e3620f22e899d8556e3648461ecd763182f4610))
- model mode selector ([#381](https://github.com/loro-dev/lody/issues/381))
  ([c080efc](https://github.com/loro-dev/lody/commit/c080efc10ef12dbe4bd9b67f3ed3cbb33a3f7a60))
- permission required
  ([a10ef41](https://github.com/loro-dev/lody/commit/a10ef41143aa95189e8919e87182d16aaf6665cd))
- remove codex and claude CLI commands
  ([#348](https://github.com/loro-dev/lody/issues/348))
  ([4e54b0f](https://github.com/loro-dev/lody/commit/4e54b0f36896babce03218bba6ca62caf724eba7))
- session state machine
  ([4925a33](https://github.com/loro-dev/lody/commit/4925a33cf30ac76eae52b205baea4325e47d9047))
- single Docker container per repo
  ([#264](https://github.com/loro-dev/lody/issues/264))
  ([b5b4327](https://github.com/loro-dev/lody/commit/b5b4327f57cf6ae5457312b3f8e0d89eafa3e032))
- state machine
  ([479c21c](https://github.com/loro-dev/lody/commit/479c21c71d0b67282a9767c999d8c07df72cd0a9))
- sync and display ACP plan
  ([#316](https://github.com/loro-dev/lody/issues/316))
  ([d8fc433](https://github.com/loro-dev/lody/commit/d8fc433c4d5669a080f863b8651d9aec3ecab39c))
- sync session startup progress
  ([#296](https://github.com/loro-dev/lody/issues/296))
  ([9620f05](https://github.com/loro-dev/lody/commit/9620f055aa741f97fd7fa17b1d0c67429b38089c))
- terminal bk
  ([346ae5a](https://github.com/loro-dev/lody/commit/346ae5a6187c37ab6348a9b57de65166d7550bb3))
- terminal interface
  ([d59b610](https://github.com/loro-dev/lody/commit/d59b610ca668c5af9b83c8d8600cb97402b3ba05))
- test ci
  ([9556569](https://github.com/loro-dev/lody/commit/955656924e904546ec062f8d8daec090ee10cd73))
- **cli:** auto-generate meaningful branch names when creating PRs
  ([#521](https://github.com/loro-dev/lody/issues/521))
  ([35ea76a](https://github.com/loro-dev/lody/commit/35ea76ae926501e359847ff6ab37a53f6cdcf814))
- implement external chat history resume fallback
  ([#534](https://github.com/loro-dev/lody/issues/534))
  ([8bbacec](https://github.com/loro-dev/lody/commit/8bbacecea3032eb1291d2a2c94e7044fef00b466))
- resume chat after closed session
  ([#506](https://github.com/loro-dev/lody/issues/506))
  ([0b4b388](https://github.com/loro-dev/lody/commit/0b4b3884a550fd68997a3a830e45d21baa26a910))
- send onesignal push on session completion
  ([#528](https://github.com/loro-dev/lody/issues/528))
  ([328285d](https://github.com/loro-dev/lody/commit/328285d12287f7f30c5242ca3ab969e7fb6bd1be))

### Bug Fixes

- **cli:** clarify gh pr body formatting instruction
  ([#525](https://github.com/loro-dev/lody/issues/525))
  ([54baa7e](https://github.com/loro-dev/lody/commit/54baa7e5369de28e26a16427e536d297d28395fa))
- **cli:** compact session history tool payloads
  ([#497](https://github.com/loro-dev/lody/issues/497))
  ([e2f18da](https://github.com/loro-dev/lody/commit/e2f18da1f7f5077f22cabfeca6602ae91ec45bc0))
- **cli:** disable terminal capability in title agent
  ([#523](https://github.com/loro-dev/lody/issues/523))
  ([d19d2a0](https://github.com/loro-dev/lody/commit/d19d2a037debf8b11bb4de0c1232014226372b2d))
- **cli:** prevent startup hang on firstSyncedWithRemote
  ([#532](https://github.com/loro-dev/lody/issues/532))
  ([956cb28](https://github.com/loro-dev/lody/commit/956cb2877190a4fae79afc218c9a129d6aa5e2ad))
- **cli:** remove duplicate code in handleSessionChat
  ([#535](https://github.com/loro-dev/lody/issues/535))
  ([f7d6dd5](https://github.com/loro-dev/lody/commit/f7d6dd53bb316cf38b17ae8accaef9956a849edb))
- stop org retry on missing member
  ([#518](https://github.com/loro-dev/lody/issues/518))
  ([bb762c6](https://github.com/loro-dev/lody/commit/bb762c6db16adf1cdd69846ca7bc3f53ba219dee))

## [0.25.3-next.1](https://github.com/loro-dev/lody/compare/lody-cli-v0.25.2-next.1...lody-cli-v0.25.3-next.1) (2025-12-27)

### Bug Fixes

- cli __filename
  ([e58f121](https://github.com/loro-dev/lody/commit/e58f1214090438b6c431072adce76f5d39c1d9ab))

## [0.25.2-next.1](https://github.com/loro-dev/lody/compare/lody-cli-v0.25.1-next.1...lody-cli-v0.25.2-next.1) (2025-12-27)

### Features

- test ci
  ([9556569](https://github.com/loro-dev/lody/commit/955656924e904546ec062f8d8daec090ee10cd73))

## [0.25.1-next.1](https://github.com/loro-dev/lody/compare/lody-cli-v0.25.0-next.1...lody-cli-v0.25.1-next.1) (2025-12-27)

### Bug Fixes

- cli env
  ([dcc5c06](https://github.com/loro-dev/lody/commit/dcc5c069d7543d7f06694e3847dcf8f89a38505b))

## [0.25.0-next.1](https://github.com/loro-dev/lody/compare/lody-cli-v0.24.0-next.1...lody-cli-v0.25.0-next.1) (2025-12-27)

### Features

- acp
  ([fc0b287](https://github.com/loro-dev/lody/commit/fc0b28764ff8bfe3c38aae10274afa5a1e69d675))
- **acp-history:** persist codex command output as terminal blocks
  ([df4e231](https://github.com/loro-dev/lody/commit/df4e231908092ecff7c7c3026f37ed95565a2cde))
- Add `supportCliTypes` to machine metadata and filter agent selections by
  supported CLI types. ([#369](https://github.com/loro-dev/lody/issues/369))
  ([93ffef1](https://github.com/loro-dev/lody/commit/93ffef17aa67dedd39b5599805ebcf802a49800a))
- add acp model mode history & add e2e test
  ([#422](https://github.com/loro-dev/lody/issues/422))
  ([94072da](https://github.com/loro-dev/lody/commit/94072da2470b78eda9e1c8db1f8a08bbb2eb5e9d))
- add command output to history
  ([1fe2009](https://github.com/loro-dev/lody/commit/1fe20095008ff9173f3f3db3586d508d9eff6d0b))
- Add Git credential helper and GitHub token management for CLI.
  ([5b922a5](https://github.com/loro-dev/lody/commit/5b922a5822c3ec7d9c3fd1e525ec7b70bd797838))
- add machine mode support ([#251](https://github.com/loro-dev/lody/issues/251))
  ([dc39fe9](https://github.com/loro-dev/lody/commit/dc39fe9cb2228f39b5393ce0bb5113fbaa0e83e3))
- add pr webhook reporting and show PR info
  ([#267](https://github.com/loro-dev/lody/issues/267))
  ([0fb67d0](https://github.com/loro-dev/lody/commit/0fb67d0ba0ad4f5299307d8d4d465b669a807a1d))
- add reconnect logic and event handlers for WebSocket connections
  ([#207](https://github.com/loro-dev/lody/issues/207))
  ([f6c823c](https://github.com/loro-dev/lody/commit/f6c823c615c6623992db953d13cac90a6a85fe0d))
- add session chat read status indicator
  ([ed339d8](https://github.com/loro-dev/lody/commit/ed339d8425435e45c993d6d7c94e3b5b9caded5c))
- add session chat read status indicator
  ([c291c75](https://github.com/loro-dev/lody/commit/c291c75e5e5ca976b077a4b3a32839de9e2400a8))
- add session creation dialog 6866ca44
  ([4706b05](https://github.com/loro-dev/lody/commit/4706b0595c4a03138081e73af26d24a172cdf6b0))
- add user metadata to session history
  ([3b54339](https://github.com/loro-dev/lody/commit/3b54339f4796f06c7a8121dcebd275f5b7c6c42b))
- agent config meta
  ([2d8afe4](https://github.com/loro-dev/lody/commit/2d8afe4c53f30417367fb2cc86fd051d31a9998c))
- align pr session association
  ([#368](https://github.com/loro-dev/lody/issues/368))
  ([8786bf8](https://github.com/loro-dev/lody/commit/8786bf8c05a476a0a9e9d0e9c486dacc25505f38))
- associate sessions with pull requests
  ([#444](https://github.com/loro-dev/lody/issues/444))
  ([724badf](https://github.com/loro-dev/lody/commit/724badfdaada1a247b76511a982801841954c5ca))
- cli loro repo
  ([f89ba5b](https://github.com/loro-dev/lody/commit/f89ba5b63da0b3d03d42d7bc1ff8757a20fcb38a))
- **components:** persist chat landing defaults
  ([#403](https://github.com/loro-dev/lody/issues/403))
  ([bcebd48](https://github.com/loro-dev/lody/commit/bcebd486274c13b9a0da7f1d0309ef711ecfd871))
- **components:** sidebar ([#357](https://github.com/loro-dev/lody/issues/357))
  ([eea270e](https://github.com/loro-dev/lody/commit/eea270e99f81a7de6f1d0250199d9fcce17ca89d))
- ensure Lody's helper is prioritized by clearing existing ones.
  ([#439](https://github.com/loro-dev/lody/issues/439))
  ([e770edc](https://github.com/loro-dev/lody/commit/e770edcf931aeefebced84a4ac254642a862afd9))
- eph machine
  ([c35a894](https://github.com/loro-dev/lody/commit/c35a894d0b6685f5cb08cca75be50e2fe6771496))
- Generate session titles via local agent on remote creates
  ([#270](https://github.com/loro-dev/lody/issues/270))
  ([0be87f4](https://github.com/loro-dev/lody/commit/0be87f428f5227b91e1b7b2b8b340b61afcd1724))
- gh token
  ([7f86f8b](https://github.com/loro-dev/lody/commit/7f86f8b55d436cadc11d47ea3f7eaad4fe3a67c4))
- Implement and integrate a new session status state machine with validation and
  new statuses.
  ([97da3d0](https://github.com/loro-dev/lody/commit/97da3d08fb479286913e0ecf8f6c9c06d1afd1ab))
- Implement session archiving
  ([#379](https://github.com/loro-dev/lody/issues/379))
  ([1a1ba8a](https://github.com/loro-dev/lody/commit/1a1ba8ae355b5800504724f1a73c92344b8518ed))
- introduce 'created' session status as initial state, replacing 'establish' and
  adjusting related logic and translations.
  ([a3aad2f](https://github.com/loro-dev/lody/commit/a3aad2fb350d3ddd4481ebc982e562383faaed5e))
- introduce LODY_USER_ID and update issue action handling
  ([f485957](https://github.com/loro-dev/lody/commit/f485957e3d327da78f9be7813d444a9cc2391819))
- invite-code beta gate ([#472](https://github.com/loro-dev/lody/issues/472))
  ([83947a2](https://github.com/loro-dev/lody/commit/83947a2d57d6841c430914dfa29a4267d63f0831))
- loro repo
  ([3fbba87](https://github.com/loro-dev/lody/commit/3fbba8755be5321db28ed47ae6d893b4202315b6))
- loro repo issue meta
  ([3c01b46](https://github.com/loro-dev/lody/commit/3c01b4662925973fd0adfbea9d2c054ad06e5eea))
- machine meta
  ([a7dc15a](https://github.com/loro-dev/lody/commit/a7dc15a168dca138d818312cef03d5c71e0b8c86))
- machine meta
  ([2e3620f](https://github.com/loro-dev/lody/commit/2e3620f22e899d8556e3648461ecd763182f4610))
- model mode selector ([#381](https://github.com/loro-dev/lody/issues/381))
  ([c080efc](https://github.com/loro-dev/lody/commit/c080efc10ef12dbe4bd9b67f3ed3cbb33a3f7a60))
- permission required
  ([a10ef41](https://github.com/loro-dev/lody/commit/a10ef41143aa95189e8919e87182d16aaf6665cd))
- remove codex and claude CLI commands
  ([#348](https://github.com/loro-dev/lody/issues/348))
  ([4e54b0f](https://github.com/loro-dev/lody/commit/4e54b0f36896babce03218bba6ca62caf724eba7))
- session state machine
  ([4925a33](https://github.com/loro-dev/lody/commit/4925a33cf30ac76eae52b205baea4325e47d9047))
- single Docker container per repo
  ([#264](https://github.com/loro-dev/lody/issues/264))
  ([b5b4327](https://github.com/loro-dev/lody/commit/b5b4327f57cf6ae5457312b3f8e0d89eafa3e032))
- state machine
  ([479c21c](https://github.com/loro-dev/lody/commit/479c21c71d0b67282a9767c999d8c07df72cd0a9))
- sync and display ACP plan
  ([#316](https://github.com/loro-dev/lody/issues/316))
  ([d8fc433](https://github.com/loro-dev/lody/commit/d8fc433c4d5669a080f863b8651d9aec3ecab39c))
- sync session startup progress
  ([#296](https://github.com/loro-dev/lody/issues/296))
  ([9620f05](https://github.com/loro-dev/lody/commit/9620f055aa741f97fd7fa17b1d0c67429b38089c))
- terminal bk
  ([346ae5a](https://github.com/loro-dev/lody/commit/346ae5a6187c37ab6348a9b57de65166d7550bb3))
- terminal interface
  ([d59b610](https://github.com/loro-dev/lody/commit/d59b610ca668c5af9b83c8d8600cb97402b3ba05))

### Bug Fixes

- fix:
  ([898c76d](https://github.com/loro-dev/lody/commit/898c76d84673c4686e9e106aaa5a98107608b54f))
- fix:
  ([955040d](https://github.com/loro-dev/lody/commit/955040dc6f27ca70bac2cf07a2c5b185ad9cd941))
- add debug logging for session read state
  ([c12cf2a](https://github.com/loro-dev/lody/commit/c12cf2a5db1802aba76dcfadb3242ce19d6cec51))
- add log about the content failed to parse
  ([#258](https://github.com/loro-dev/lody/issues/258))
  ([da70da3](https://github.com/loro-dev/lody/commit/da70da3c36e2c75f55a336eeab3279edd110ad57))
- adjust session termination status
  ([316d549](https://github.com/loro-dev/lody/commit/316d54903132a09f0ac13a8ad72159475caada30))
- agent thought
  ([d601320](https://github.com/loro-dev/lody/commit/d601320cec202fab5d4c8bbedd1c7b81616db542))
- background ([#231](https://github.com/loro-dev/lody/issues/231))
  ([63a6f32](https://github.com/loro-dev/lody/commit/63a6f326b271cce0d2cbb37dccf3924d076b6e73))
- chat
  ([cbc9b91](https://github.com/loro-dev/lody/commit/cbc9b91503c301746fff2af70079ee378a4b887d))
- chat ui ([#321](https://github.com/loro-dev/lody/issues/321))
  ([a7caa4b](https://github.com/loro-dev/lody/commit/a7caa4bdef3aa15ae98d648c434b01eaa1134a4c))
- cli
  ([532ca8d](https://github.com/loro-dev/lody/commit/532ca8db961df2186c6048547b5849da51ea9b6f))
- cli
  ([d3832c4](https://github.com/loro-dev/lody/commit/d3832c498ece09f85115666bb9f2d95fb49cfc19))
- cli cc codex
  ([bb878af](https://github.com/loro-dev/lody/commit/bb878af3a55f514c545bcdcf9d8b22402e1c1fc5))
- **cli:** auto-mark latest user history as read
  ([#387](https://github.com/loro-dev/lody/issues/387))
  ([eac5061](https://github.com/loro-dev/lody/commit/eac50614598d4dd8193de3cc5814a2869155ca15))
- **cli:** base worktrees on origin/main
  ([#352](https://github.com/loro-dev/lody/issues/352))
  ([740ce40](https://github.com/loro-dev/lody/commit/740ce4078caf923f09f1a86b6ea491b819661dda))
- **cli:** clarify gh pr body newlines
  ([#401](https://github.com/loro-dev/lody/issues/401))
  ([803a240](https://github.com/loro-dev/lody/commit/803a24061b2b1b139f516103398d30d1f79eb9b4))
- **cli:** dedupe replayed thought chunks in history
  ([#314](https://github.com/loro-dev/lody/issues/314))
  ([468f533](https://github.com/loro-dev/lody/commit/468f53382de63f6f2723e7357db3655322fa7f10))
- **cli:** default start to foreground
  ([#469](https://github.com/loro-dev/lody/issues/469))
  ([1cedb8a](https://github.com/loro-dev/lody/commit/1cedb8a1c4fce67a055bb7ab959f869d01c074bd))
- **cli:** don't hard-exit on unhandledRejection
  ([#318](https://github.com/loro-dev/lody/issues/318))
  ([77ed07f](https://github.com/loro-dev/lody/commit/77ed07fb21f457ceae84685f9c022b656ee20a41))
- **cli:** group agent turn into single history item
  ([#297](https://github.com/loro-dev/lody/issues/297))
  ([af803a8](https://github.com/loro-dev/lody/commit/af803a8831436326fc1eb79b6ef3e08cd6ee4d52))
- **cli:** improve object logging
  ([c34a1cf](https://github.com/loro-dev/lody/commit/c34a1cf7be0005bcb41e51e4211b63c610c7dc53))
- **cli:** improve object logging
  ([8f62b63](https://github.com/loro-dev/lody/commit/8f62b63028fea36e48ddb4ea2e45fbbbd4c68d29))
- **cli:** prevent title agent git repo warning
  ([#499](https://github.com/loro-dev/lody/issues/499))
  ([14ac219](https://github.com/loro-dev/lody/commit/14ac219386ab642025706a6af8b514fa77f5f419))
- **cli:** print happy coding message after machine registration
  ([#500](https://github.com/loro-dev/lody/issues/500))
  ([02047e1](https://github.com/loro-dev/lody/commit/02047e1509ea2e201bf6a7664da213d5a27aae99))
- **cli:** require plain-text session titles
  ([#310](https://github.com/loro-dev/lody/issues/310))
  ([d9e1d5f](https://github.com/loro-dev/lody/commit/d9e1d5f652a69d56a9f3e163fd970947aa590f32))
- **cli:** reset machine_disconnected sessions on reconnect
  ([#359](https://github.com/loro-dev/lody/issues/359))
  ([db7428c](https://github.com/loro-dev/lody/commit/db7428c437ea9222b2bbd04e42e858215591508b))
- **cli:** restore soft-deleted machine doc
  ([#392](https://github.com/loro-dev/lody/issues/392))
  ([ede42f5](https://github.com/loro-dev/lody/commit/ede42f55d72fdaa0a4e46a77a4241290a3a59047))
- **cli:** skip github helper for non-github remotes
  ([81d7c44](https://github.com/loro-dev/lody/commit/81d7c446a1a0c4f654e2e26d1726c10f86ac0580))
- **cli:** support LODY_REPOS_DIR
  ([eac059b](https://github.com/loro-dev/lody/commit/eac059b0b749fe64fc14ebb3325a6c9bd5366ef5))
- **cli:** sync git branch name into session meta
  ([#390](https://github.com/loro-dev/lody/issues/390))
  ([08b89bf](https://github.com/loro-dev/lody/commit/08b89bf72322f01136b0447cca5afcd87336b0d1))
- do
  ([38081bf](https://github.com/loro-dev/lody/commit/38081bff528329d883802ac315c2eafc9b38feb2))
- docker stream
  ([9ab1310](https://github.com/loro-dev/lody/commit/9ab1310058aea38bde74882c4254ba44f5ee6c35))
- docker terminal
  ([164e4f9](https://github.com/loro-dev/lody/commit/164e4f92d5c7c25349d3a9e473c5d3e1459186c5))
- don't need to append pr prompt for each message
  ([2195eb1](https://github.com/loro-dev/lody/commit/2195eb1d840cac56540598df3cc60facba3aefd4))
- eph
  ([8cc43bb](https://github.com/loro-dev/lody/commit/8cc43bb1650727fec87df479ff664cba8e807b11))
- eph err
  ([c3e369d](https://github.com/loro-dev/lody/commit/c3e369d98d3bb43b1132508ccf012ea5a0958d55))
- error
  ([2f9c891](https://github.com/loro-dev/lody/commit/2f9c891564295dfcc4d4998f51a9ede52a5e9fb5))
- find machine by id in do
  ([3a0fbe1](https://github.com/loro-dev/lody/commit/3a0fbe1cd72fa095f90d69bf257d8fd9ca4e5a27))
- gh wrapper ([#360](https://github.com/loro-dev/lody/issues/360))
  ([439784f](https://github.com/loro-dev/lody/commit/439784fe4d21fa154a9585fbba0b5840d72e916f))
- handle agent process termination and logging
  ([353fe5f](https://github.com/loro-dev/lody/commit/353fe5f33332ba76e5f9db37de1d16d0d18b6831))
- improve error handling and avoid process being undefined
  ([ceb3939](https://github.com/loro-dev/lody/commit/ceb3939743ae193ae55949bc36ccc484d658def8))
- improve GitHubTokenManager logic
  ([#435](https://github.com/loro-dev/lody/issues/435))
  ([1443c2a](https://github.com/loro-dev/lody/commit/1443c2a604d4385e4b0a884408fe81233775bb17))
- let CLI generate session titles
  ([#291](https://github.com/loro-dev/lody/issues/291))
  ([fb01429](https://github.com/loro-dev/lody/commit/fb01429e46c7a16b9eb0b7aa7a604d38e73286bc))
- Linux Docker git auth PRD
  ([#480](https://github.com/loro-dev/lody/issues/480))
  ([495d374](https://github.com/loro-dev/lody/commit/495d374108fcf3cba1a416dbb8775fa354e2fe65))
- machine reconnect register
  ([b03f088](https://github.com/loro-dev/lody/commit/b03f0884f0b01c1f43caeea2adc1506cb5736b01))
- make cli type safer ([#249](https://github.com/loro-dev/lody/issues/249))
  ([673bded](https://github.com/loro-dev/lody/commit/673bded1c7ba9403b4d9b84c67aaf5d6739a43c3))
- mark msg as read as soon as received new session doc
  ([#399](https://github.com/loro-dev/lody/issues/399))
  ([35f7550](https://github.com/loro-dev/lody/commit/35f75504da8015736bc2fbf65742f19948164ea8))
- mark terminated machine sessions correctly
  ([#242](https://github.com/loro-dev/lody/issues/242))
  ([c8504bc](https://github.com/loro-dev/lody/commit/c8504bca422a2ceddcd08d129a4bfb96742a0e43))
- merge
  ([8a56f30](https://github.com/loro-dev/lody/commit/8a56f30edf707163ae94b7635c424e833f4db26a))
- module
  ([c5fb124](https://github.com/loro-dev/lody/commit/c5fb12412cc2586b006bfdd0bd4d0943fe7915db))
- never destroy sub
  ([ded2407](https://github.com/loro-dev/lody/commit/ded24071742ebe062a5c6a620a2ea6f50f8e8cd0))
- prevent uncaught ws error crash
  ([#265](https://github.com/loro-dev/lody/issues/265))
  ([1ae60e5](https://github.com/loro-dev/lody/commit/1ae60e575575133df96074cedafdaa6c0a310a3f))
- re-register machine after reconnect
  ([#266](https://github.com/loro-dev/lody/issues/266))
  ([7b5eba7](https://github.com/loro-dev/lody/commit/7b5eba7a9d4526616f68e060d8220d925fe14f91))
- refine title gen and session start process
  ([#294](https://github.com/loro-dev/lody/issues/294))
  ([37a5504](https://github.com/loro-dev/lody/commit/37a550450833910ed33b0a0c084aa523f009d20c))
- release
  ([4a31721](https://github.com/loro-dev/lody/commit/4a317214c4c3f6568202186976801a82bf7de25b))
- repo
  ([13712c0](https://github.com/loro-dev/lody/commit/13712c0fbd61c5b196e334138a62ab211ceabe54))
- require CLI ack for session create
  ([#498](https://github.com/loro-dev/lody/issues/498))
  ([42df83d](https://github.com/loro-dev/lody/commit/42df83dc33083039156cfd2be8fadbe8fe1f86c1))
- sentry
  ([6826e62](https://github.com/loro-dev/lody/commit/6826e622d05173dc73b8cbff576efadc79438005))
- sentry do not need in cli
  ([d16d29d](https://github.com/loro-dev/lody/commit/d16d29d350bfd2c81b37ba03c83a01a0c98b3353))
- session history be overwritten
  ([#234](https://github.com/loro-dev/lody/issues/234))
  ([5b0b63a](https://github.com/loro-dev/lody/commit/5b0b63a30ce11f283398a674614d36adcaa4ac26))
- session terminated
  ([a291e22](https://github.com/loro-dev/lody/commit/a291e22b508f7edffe480f80dad6f1bd92df8e0b))
- sessions loading and syncing issues
  ([#378](https://github.com/loro-dev/lody/issues/378))
  ([5ebe050](https://github.com/loro-dev/lody/commit/5ebe050a934428b8dfc9d4216ca39b23fb9b5ba8))
- short title ([#330](https://github.com/loro-dev/lody/issues/330))
  ([eec0acc](https://github.com/loro-dev/lody/commit/eec0acc51bfb509d4323a093c0103792241fe476))
- switch to git-credential auth
  ([92a30ba](https://github.com/loro-dev/lody/commit/92a30ba6614de76cc4ab44c18a212f56e702565c))
- Track session read status with message timestamps
  ([#413](https://github.com/loro-dev/lody/issues/413))
  ([1a5cbe7](https://github.com/loro-dev/lody/commit/1a5cbe709426615d0d2a2b7a52dabbaf2f3cdbe7))
- user chat
  ([ee244ff](https://github.com/loro-dev/lody/commit/ee244ff9e7f1e03cf465563d0a3d1062007e9eac))
- watch machine meta for soft delete
  ([#400](https://github.com/loro-dev/lody/issues/400))
  ([331bd82](https://github.com/loro-dev/lody/commit/331bd8280042f89ac9cfc0c1f6be57e89737d800))
- worktree dir issue ([#288](https://github.com/loro-dev/lody/issues/288))
  ([dec7e2d](https://github.com/loro-dev/lody/commit/dec7e2d085df7ef90fd3126f92224c55695f89e9))
- ws message type
  ([d17e835](https://github.com/loro-dev/lody/commit/d17e835abcfc7827c654107764b59307d9ae9789))
- zod is too strict for message content
  ([#260](https://github.com/loro-dev/lody/issues/260))
  ([b312f6f](https://github.com/loro-dev/lody/commit/b312f6f5f77ea54f45cc43c803b82a384501de8a))

### Performance

- **cli:** start ACP from bundled deps
  ([#483](https://github.com/loro-dev/lody/issues/483))
  ([45f0e89](https://github.com/loro-dev/lody/commit/45f0e89318e13fdc498db1fbb7c6c4548d4dc972))
- speedup applyMessageContents in handle acp update message
  ([#256](https://github.com/loro-dev/lody/issues/256))
  ([a052d3d](https://github.com/loro-dev/lody/commit/a052d3d9e7da3295831a0056417b8dbd2dac9e64))

### Refactors

- make cli testable and fix title extract logics
  ([af85e30](https://github.com/loro-dev/lody/commit/af85e3081cbe6128ef41f2027a237e50cfc6a303))
- migrate loro-mirror history schema to use Any items
  ([fdb3bb1](https://github.com/loro-dev/lody/commit/fdb3bb1a34862799b463d402e838647f3527d8ab))
- refactor and optimize frontend
  ([#345](https://github.com/loro-dev/lody/issues/345))
  ([3ba2392](https://github.com/loro-dev/lody/commit/3ba2392f38a53d30871a83795c3cd1c3d17dade0))
- remove createdAt from session heartbeat
  ([93ea4fe](https://github.com/loro-dev/lody/commit/93ea4fed61ddd9d2c9715056ff7b453a4164b57c))
- remove error handling from ephemeral session updates and streamline session
  management
  ([17e11df](https://github.com/loro-dev/lody/commit/17e11dfc3eec63d1ee05ffd20cc4325fff802956))
- simplify git credential handling
  ([8bbfc6d](https://github.com/loro-dev/lody/commit/8bbfc6d57e9f40df12a484e6bf61fc59bb5def93))
- Simplify GitHub token management by removing the `isPrivate` flag and adding
  tests.
  ([9b579e9](https://github.com/loro-dev/lody/commit/9b579e9ce126847f28f987250636b30e225e5f40))
- standardize session error handling and update error codes
  ([128a1f9](https://github.com/loro-dev/lody/commit/128a1f99f4344e4e4ed9bcb2be81bc51036451ef))
- update logging and registration logic in agent-client and message-handler
  ([7c248a2](https://github.com/loro-dev/lody/commit/7c248a21f3d10d135bed1c862b8841e350206eb9))

## [0.23.0](https://github.com/loro-dev/lody/compare/lody-cli-v0.22.1...lody-cli-v0.23.0) (2025-12-25)

### Features

- associate sessions with pull requests
  ([#444](https://github.com/loro-dev/lody/issues/444))
  ([724badf](https://github.com/loro-dev/lody/commit/724badfdaada1a247b76511a982801841954c5ca))
- ensure Lody's helper is prioritized by clearing existing ones.
  ([#439](https://github.com/loro-dev/lody/issues/439))
  ([e770edc](https://github.com/loro-dev/lody/commit/e770edcf931aeefebced84a4ac254642a862afd9))

### Bug Fixes

- **cli:** default start to foreground
  ([#469](https://github.com/loro-dev/lody/issues/469))
  ([1cedb8a](https://github.com/loro-dev/lody/commit/1cedb8a1c4fce67a055bb7ab959f869d01c074bd))

## [0.22.1](https://github.com/loro-dev/lody/compare/lody-cli-v0.22.0...lody-cli-v0.22.1) (2025-12-24)

### Bug Fixes

- improve GitHubTokenManager logic
  ([#435](https://github.com/loro-dev/lody/issues/435))
  ([1443c2a](https://github.com/loro-dev/lody/commit/1443c2a604d4385e4b0a884408fe81233775bb17))

## [0.22.0](https://github.com/loro-dev/lody/compare/lody-cli-v0.21.1...lody-cli-v0.22.0) (2025-12-23)

### Features

- add acp model mode history & add e2e test
  ([#422](https://github.com/loro-dev/lody/issues/422))
  ([94072da](https://github.com/loro-dev/lody/commit/94072da2470b78eda9e1c8db1f8a08bbb2eb5e9d))

## [0.21.1](https://github.com/loro-dev/lody/compare/lody-cli-v0.21.0...lody-cli-v0.21.1) (2025-12-23)

### Bug Fixes

- Track session read status with message timestamps
  ([#413](https://github.com/loro-dev/lody/issues/413))
  ([1a5cbe7](https://github.com/loro-dev/lody/commit/1a5cbe709426615d0d2a2b7a52dabbaf2f3cdbe7))

## [0.21.0](https://github.com/loro-dev/lody/compare/lody-cli-v0.20.3...lody-cli-v0.21.0) (2025-12-22)

### Features

- **components:** persist chat landing defaults
  ([#403](https://github.com/loro-dev/lody/issues/403))
  ([bcebd48](https://github.com/loro-dev/lody/commit/bcebd486274c13b9a0da7f1d0309ef711ecfd871))
- Implement session archiving
  ([#379](https://github.com/loro-dev/lody/issues/379))
  ([1a1ba8a](https://github.com/loro-dev/lody/commit/1a1ba8ae355b5800504724f1a73c92344b8518ed))

## [0.20.3](https://github.com/loro-dev/lody/compare/lody-cli-v0.20.2...lody-cli-v0.20.3) (2025-12-22)

### Bug Fixes

- **cli:** clarify gh pr body newlines
  ([#401](https://github.com/loro-dev/lody/issues/401))
  ([803a240](https://github.com/loro-dev/lody/commit/803a24061b2b1b139f516103398d30d1f79eb9b4))
- **cli:** sync git branch name into session meta
  ([#390](https://github.com/loro-dev/lody/issues/390))
  ([08b89bf](https://github.com/loro-dev/lody/commit/08b89bf72322f01136b0447cca5afcd87336b0d1))
- mark msg as read as soon as received new session doc
  ([#399](https://github.com/loro-dev/lody/issues/399))
  ([35f7550](https://github.com/loro-dev/lody/commit/35f75504da8015736bc2fbf65742f19948164ea8))
- watch machine meta for soft delete
  ([#400](https://github.com/loro-dev/lody/issues/400))
  ([331bd82](https://github.com/loro-dev/lody/commit/331bd8280042f89ac9cfc0c1f6be57e89737d800))

## [0.20.2](https://github.com/loro-dev/lody/compare/lody-cli-v0.20.1...lody-cli-v0.20.2) (2025-12-22)

### Bug Fixes

- **cli:** restore soft-deleted machine doc
  ([#392](https://github.com/loro-dev/lody/issues/392))
  ([ede42f5](https://github.com/loro-dev/lody/commit/ede42f55d72fdaa0a4e46a77a4241290a3a59047))

## [0.20.1](https://github.com/loro-dev/lody/compare/lody-cli-v0.20.0...lody-cli-v0.20.1) (2025-12-22)

### Bug Fixes

- **cli:** auto-mark latest user history as read
  ([#387](https://github.com/loro-dev/lody/issues/387))
  ([eac5061](https://github.com/loro-dev/lody/commit/eac50614598d4dd8193de3cc5814a2869155ca15))

## [0.20.0](https://github.com/loro-dev/lody/compare/lody-cli-v0.19.1...lody-cli-v0.20.0) (2025-12-22)

### Features

- model mode selector ([#381](https://github.com/loro-dev/lody/issues/381))
  ([c080efc](https://github.com/loro-dev/lody/commit/c080efc10ef12dbe4bd9b67f3ed3cbb33a3f7a60))

## [0.19.1](https://github.com/loro-dev/lody/compare/lody-cli-v0.19.0...lody-cli-v0.19.1) (2025-12-21)

### Bug Fixes

- sessions loading and syncing issues
  ([#378](https://github.com/loro-dev/lody/issues/378))
  ([5ebe050](https://github.com/loro-dev/lody/commit/5ebe050a934428b8dfc9d4216ca39b23fb9b5ba8))

## [0.19.0](https://github.com/loro-dev/lody/compare/lody-cli-v0.18.0...lody-cli-v0.19.0) (2025-12-20)

### Features

- **components:** sidebar ([#357](https://github.com/loro-dev/lody/issues/357))
  ([eea270e](https://github.com/loro-dev/lody/commit/eea270e99f81a7de6f1d0250199d9fcce17ca89d))

### Bug Fixes

- sentry do not need in cli
  ([d16d29d](https://github.com/loro-dev/lody/commit/d16d29d350bfd2c81b37ba03c83a01a0c98b3353))

## [0.18.0](https://github.com/loro-dev/lody/compare/lody-cli-v0.17.2...lody-cli-v0.18.0) (2025-12-20)

### Features

- Add `supportCliTypes` to machine metadata and filter agent selections by
  supported CLI types. ([#369](https://github.com/loro-dev/lody/issues/369))
  ([93ffef1](https://github.com/loro-dev/lody/commit/93ffef17aa67dedd39b5599805ebcf802a49800a))
- align pr session association
  ([#368](https://github.com/loro-dev/lody/issues/368))
  ([8786bf8](https://github.com/loro-dev/lody/commit/8786bf8c05a476a0a9e9d0e9c486dacc25505f38))
- remove codex and claude CLI commands
  ([#348](https://github.com/loro-dev/lody/issues/348))
  ([4e54b0f](https://github.com/loro-dev/lody/commit/4e54b0f36896babce03218bba6ca62caf724eba7))

## [0.17.2](https://github.com/loro-dev/lody/compare/lody-cli-v0.17.1...lody-cli-v0.17.2) (2025-12-19)

### Bug Fixes

- release
  ([4a31721](https://github.com/loro-dev/lody/commit/4a317214c4c3f6568202186976801a82bf7de25b))

## [0.17.1](https://github.com/loro-dev/lody/compare/lody-cli-v0.17.0...lody-cli-v0.17.1) (2025-12-19)

### Bug Fixes

- **cli:** reset machine_disconnected sessions on reconnect
  ([#359](https://github.com/loro-dev/lody/issues/359))
  ([db7428c](https://github.com/loro-dev/lody/commit/db7428c437ea9222b2bbd04e42e858215591508b))
- gh wrapper ([#360](https://github.com/loro-dev/lody/issues/360))
  ([439784f](https://github.com/loro-dev/lody/commit/439784fe4d21fa154a9585fbba0b5840d72e916f))

## [0.17.0](https://github.com/loro-dev/lody/compare/lody-cli-v0.16.1...lody-cli-v0.17.0) (2025-12-18)

### Features

- gh token
  ([7f86f8b](https://github.com/loro-dev/lody/commit/7f86f8b55d436cadc11d47ea3f7eaad4fe3a67c4))

### Bug Fixes

- **cli:** skip github helper for non-github remotes
  ([81d7c44](https://github.com/loro-dev/lody/commit/81d7c446a1a0c4f654e2e26d1726c10f86ac0580))
- **cli:** support LODY_REPOS_DIR
  ([eac059b](https://github.com/loro-dev/lody/commit/eac059b0b749fe64fc14ebb3325a6c9bd5366ef5))
- sentry
  ([6826e62](https://github.com/loro-dev/lody/commit/6826e622d05173dc73b8cbff576efadc79438005))

### Refactors

- Simplify GitHub token management by removing the `isPrivate` flag and adding
  tests.
  ([9b579e9](https://github.com/loro-dev/lody/commit/9b579e9ce126847f28f987250636b30e225e5f40))

## [0.16.1](https://github.com/loro-dev/lody/compare/lody-cli-v0.16.0...lody-cli-v0.16.1) (2025-12-18)

### Bug Fixes

- **cli:** base worktrees on origin/main
  ([#352](https://github.com/loro-dev/lody/issues/352))
  ([740ce40](https://github.com/loro-dev/lody/commit/740ce4078caf923f09f1a86b6ea491b819661dda))

## [0.16.0](https://github.com/loro-dev/lody/compare/lody-cli-v0.15.0...lody-cli-v0.16.0) (2025-12-18)

### Features

- Implement and integrate a new session status state machine with validation and
  new statuses.
  ([97da3d0](https://github.com/loro-dev/lody/commit/97da3d08fb479286913e0ecf8f6c9c06d1afd1ab))
- introduce 'created' session status as initial state, replacing 'establish' and
  adjusting related logic and translations.
  ([a3aad2f](https://github.com/loro-dev/lody/commit/a3aad2fb350d3ddd4481ebc982e562383faaed5e))
- session state machine
  ([4925a33](https://github.com/loro-dev/lody/commit/4925a33cf30ac76eae52b205baea4325e47d9047))
- state machine
  ([479c21c](https://github.com/loro-dev/lody/commit/479c21c71d0b67282a9767c999d8c07df72cd0a9))

### Bug Fixes

- **cli:** improve object logging
  ([c34a1cf](https://github.com/loro-dev/lody/commit/c34a1cf7be0005bcb41e51e4211b63c610c7dc53))
- **cli:** improve object logging
  ([8f62b63](https://github.com/loro-dev/lody/commit/8f62b63028fea36e48ddb4ea2e45fbbbd4c68d29))

### Refactors

- refactor and optimize frontend
  ([#345](https://github.com/loro-dev/lody/issues/345))
  ([3ba2392](https://github.com/loro-dev/lody/commit/3ba2392f38a53d30871a83795c3cd1c3d17dade0))
- remove createdAt from session heartbeat
  ([93ea4fe](https://github.com/loro-dev/lody/commit/93ea4fed61ddd9d2c9715056ff7b453a4164b57c))

## [0.15.0](https://github.com/loro-dev/lody/compare/lody-cli-v0.14.0...lody-cli-v0.15.0) (2025-12-16)

### Features

- acp
  ([fc0b287](https://github.com/loro-dev/lody/commit/fc0b28764ff8bfe3c38aae10274afa5a1e69d675))
- **acp-history:** persist codex command output as terminal blocks
  ([df4e231](https://github.com/loro-dev/lody/commit/df4e231908092ecff7c7c3026f37ed95565a2cde))
- add command output to history
  ([1fe2009](https://github.com/loro-dev/lody/commit/1fe20095008ff9173f3f3db3586d508d9eff6d0b))
- add machine mode support ([#251](https://github.com/loro-dev/lody/issues/251))
  ([dc39fe9](https://github.com/loro-dev/lody/commit/dc39fe9cb2228f39b5393ce0bb5113fbaa0e83e3))
- add pr webhook reporting and show PR info
  ([#267](https://github.com/loro-dev/lody/issues/267))
  ([0fb67d0](https://github.com/loro-dev/lody/commit/0fb67d0ba0ad4f5299307d8d4d465b669a807a1d))
- add reconnect logic and event handlers for WebSocket connections
  ([#207](https://github.com/loro-dev/lody/issues/207))
  ([f6c823c](https://github.com/loro-dev/lody/commit/f6c823c615c6623992db953d13cac90a6a85fe0d))
- add session chat read status indicator
  ([ed339d8](https://github.com/loro-dev/lody/commit/ed339d8425435e45c993d6d7c94e3b5b9caded5c))
- add session chat read status indicator
  ([c291c75](https://github.com/loro-dev/lody/commit/c291c75e5e5ca976b077a4b3a32839de9e2400a8))
- add session creation dialog 6866ca44
  ([4706b05](https://github.com/loro-dev/lody/commit/4706b0595c4a03138081e73af26d24a172cdf6b0))
- add user metadata to session history
  ([3b54339](https://github.com/loro-dev/lody/commit/3b54339f4796f06c7a8121dcebd275f5b7c6c42b))
- agent config meta
  ([2d8afe4](https://github.com/loro-dev/lody/commit/2d8afe4c53f30417367fb2cc86fd051d31a9998c))
- cli loro repo
  ([f89ba5b](https://github.com/loro-dev/lody/commit/f89ba5b63da0b3d03d42d7bc1ff8757a20fcb38a))
- **cli:** open browser during login
  ([45c8e8b](https://github.com/loro-dev/lody/commit/45c8e8b9bb1ad08010b51868886799c66d35b6cb))
- **cli:** open browser during login
  ([c093d59](https://github.com/loro-dev/lody/commit/c093d59ee081e6691063259b38e0f23426408e62))
- codex resume
  ([59925b6](https://github.com/loro-dev/lody/commit/59925b62034047e8efc6ee43430ce8da5fe96421))
- eph machine
  ([c35a894](https://github.com/loro-dev/lody/commit/c35a894d0b6685f5cb08cca75be50e2fe6771496))
- Generate session titles via local agent on remote creates
  ([#270](https://github.com/loro-dev/lody/issues/270))
  ([0be87f4](https://github.com/loro-dev/lody/commit/0be87f428f5227b91e1b7b2b8b340b61afcd1724))
- introduce LODY_USER_ID and update issue action handling
  ([f485957](https://github.com/loro-dev/lody/commit/f485957e3d327da78f9be7813d444a9cc2391819))
- loro mirror & new convex auth
  ([e1dc473](https://github.com/loro-dev/lody/commit/e1dc4735fa53c73335ebbb8253f14c61be81ebef))
- loro repo
  ([3fbba87](https://github.com/loro-dev/lody/commit/3fbba8755be5321db28ed47ae6d893b4202315b6))
- loro repo issue meta
  ([3c01b46](https://github.com/loro-dev/lody/commit/3c01b4662925973fd0adfbea9d2c054ad06e5eea))
- machine meta
  ([a7dc15a](https://github.com/loro-dev/lody/commit/a7dc15a168dca138d818312cef03d5c71e0b8c86))
- machine meta
  ([2e3620f](https://github.com/loro-dev/lody/commit/2e3620f22e899d8556e3648461ecd763182f4610))
- permission required
  ([a10ef41](https://github.com/loro-dev/lody/commit/a10ef41143aa95189e8919e87182d16aaf6665cd))
- register agent by cli
  ([2cb03d4](https://github.com/loro-dev/lody/commit/2cb03d48338b88de28ed044f2cde060b29e814d8))
- register agent by cli
  ([2536154](https://github.com/loro-dev/lody/commit/253615467580fbebb12c2c85b9d8c75eff07fae1))
- resume session
  ([ff903bd](https://github.com/loro-dev/lody/commit/ff903bd4a08ebda11ac0e077969a7b0b3152ad83))
- single Docker container per repo
  ([#264](https://github.com/loro-dev/lody/issues/264))
  ([b5b4327](https://github.com/loro-dev/lody/commit/b5b4327f57cf6ae5457312b3f8e0d89eafa3e032))
- sync and display ACP plan
  ([#316](https://github.com/loro-dev/lody/issues/316))
  ([d8fc433](https://github.com/loro-dev/lody/commit/d8fc433c4d5669a080f863b8651d9aec3ecab39c))
- sync session startup progress
  ([#296](https://github.com/loro-dev/lody/issues/296))
  ([9620f05](https://github.com/loro-dev/lody/commit/9620f055aa741f97fd7fa17b1d0c67429b38089c))
- terminal bk
  ([346ae5a](https://github.com/loro-dev/lody/commit/346ae5a6187c37ab6348a9b57de65166d7550bb3))
- terminal interface
  ([d59b610](https://github.com/loro-dev/lody/commit/d59b610ca668c5af9b83c8d8600cb97402b3ba05))
- assign agent sessions from task details
  ([4c14e8e](https://github.com/loro-dev/lody/commit/4c14e8e3485895972179de1f4b1e3a8dde80e9bb))

### Bug Fixes

- fix:
  ([898c76d](https://github.com/loro-dev/lody/commit/898c76d84673c4686e9e106aaa5a98107608b54f))
- fix:
  ([955040d](https://github.com/loro-dev/lody/commit/955040dc6f27ca70bac2cf07a2c5b185ad9cd941))
- fix:
  ([1675383](https://github.com/loro-dev/lody/commit/1675383b937889f7fe459e41bde0df9fd8ff2f8c))
- fix:
  ([0eaa185](https://github.com/loro-dev/lody/commit/0eaa1854829a329e1e3022cbfcc392f164c9bfb2))
- add debug logging for session read state
  ([c12cf2a](https://github.com/loro-dev/lody/commit/c12cf2a5db1802aba76dcfadb3242ce19d6cec51))
- add log about the content failed to parse
  ([#258](https://github.com/loro-dev/lody/issues/258))
  ([da70da3](https://github.com/loro-dev/lody/commit/da70da3c36e2c75f55a336eeab3279edd110ad57))
- adjust session termination status
  ([316d549](https://github.com/loro-dev/lody/commit/316d54903132a09f0ac13a8ad72159475caada30))
- agent cli type
  ([f270509](https://github.com/loro-dev/lody/commit/f2705092fc15baa98c84c8ac263074f5fac74b11))
- agent thought
  ([d601320](https://github.com/loro-dev/lody/commit/d601320cec202fab5d4c8bbedd1c7b81616db542))
- background ([#231](https://github.com/loro-dev/lody/issues/231))
  ([63a6f32](https://github.com/loro-dev/lody/commit/63a6f326b271cce0d2cbb37dccf3924d076b6e73))
- chat
  ([cbc9b91](https://github.com/loro-dev/lody/commit/cbc9b91503c301746fff2af70079ee378a4b887d))
- chat ui ([#321](https://github.com/loro-dev/lody/issues/321))
  ([a7caa4b](https://github.com/loro-dev/lody/commit/a7caa4bdef3aa15ae98d648c434b01eaa1134a4c))
- claude
  ([e6f0687](https://github.com/loro-dev/lody/commit/e6f068785f6d3939151a1e48a9f91c317386683c))
- cli
  ([532ca8d](https://github.com/loro-dev/lody/commit/532ca8db961df2186c6048547b5849da51ea9b6f))
- cli
  ([d3832c4](https://github.com/loro-dev/lody/commit/d3832c498ece09f85115666bb9f2d95fb49cfc19))
- cli build
  ([2264da4](https://github.com/loro-dev/lody/commit/2264da4c750cd303de2543b75c1b5be694bd4e5a))
- cli cc codex
  ([bb878af](https://github.com/loro-dev/lody/commit/bb878af3a55f514c545bcdcf9d8b22402e1c1fc5))
- cli codex resume
  ([d0f55ee](https://github.com/loro-dev/lody/commit/d0f55ee13c90e18cbef060b6f9a43862eb7e023d))
- cli session
  ([1a3c5ed](https://github.com/loro-dev/lody/commit/1a3c5ed3bfdec26c5f233f3d9a55f84411bc9e7e))
- cli session
  ([0c99e40](https://github.com/loro-dev/lody/commit/0c99e406394e3d1483b10d5a97de61c1411ba9e6))
- cli type
  ([67b5e9c](https://github.com/loro-dev/lody/commit/67b5e9c5713108e423702f3e057fc453eba7b848))
- **cli:** dedupe replayed thought chunks in history
  ([#314](https://github.com/loro-dev/lody/issues/314))
  ([468f533](https://github.com/loro-dev/lody/commit/468f53382de63f6f2723e7357db3655322fa7f10))
- **cli:** don't hard-exit on unhandledRejection
  ([#318](https://github.com/loro-dev/lody/issues/318))
  ([77ed07f](https://github.com/loro-dev/lody/commit/77ed07fb21f457ceae84685f9c022b656ee20a41))
- **cli:** group agent turn into single history item
  ([#297](https://github.com/loro-dev/lody/issues/297))
  ([af803a8](https://github.com/loro-dev/lody/commit/af803a8831436326fc1eb79b6ef3e08cd6ee4d52))
- **cli:** require plain-text session titles
  ([#310](https://github.com/loro-dev/lody/issues/310))
  ([d9e1d5f](https://github.com/loro-dev/lody/commit/d9e1d5f652a69d56a9f3e163fd970947aa590f32))
- codex option
  ([13d2a00](https://github.com/loro-dev/lody/commit/13d2a0038fa60d4b976c2dd466bc0766c4d3390c))
- codex token ui
  ([fcf7797](https://github.com/loro-dev/lody/commit/fcf7797954a425432529fa7126dec69fddf11f56))
- convex auth
  ([727f25e](https://github.com/loro-dev/lody/commit/727f25ec476a5bf9e45fc4e2dad62cb9785fb047))
- debug log
  ([d6d6e31](https://github.com/loro-dev/lody/commit/d6d6e31f6df1487559e64964b1642f20fb390e4d))
- do
  ([38081bf](https://github.com/loro-dev/lody/commit/38081bff528329d883802ac315c2eafc9b38feb2))
- docker stream
  ([9ab1310](https://github.com/loro-dev/lody/commit/9ab1310058aea38bde74882c4254ba44f5ee6c35))
- docker terminal
  ([164e4f9](https://github.com/loro-dev/lody/commit/164e4f92d5c7c25349d3a9e473c5d3e1459186c5))
- don't need to append pr prompt for each message
  ([2195eb1](https://github.com/loro-dev/lody/commit/2195eb1d840cac56540598df3cc60facba3aefd4))
- eph
  ([8cc43bb](https://github.com/loro-dev/lody/commit/8cc43bb1650727fec87df479ff664cba8e807b11))
- eph err
  ([c3e369d](https://github.com/loro-dev/lody/commit/c3e369d98d3bb43b1132508ccf012ea5a0958d55))
- error
  ([2f9c891](https://github.com/loro-dev/lody/commit/2f9c891564295dfcc4d4998f51a9ede52a5e9fb5))
- find machine by id in do
  ([3a0fbe1](https://github.com/loro-dev/lody/commit/3a0fbe1cd72fa095f90d69bf257d8fd9ca4e5a27))
- handle agent process termination and logging
  ([353fe5f](https://github.com/loro-dev/lody/commit/353fe5f33332ba76e5f9db37de1d16d0d18b6831))
- improve error handling and avoid process being undefined
  ([ceb3939](https://github.com/loro-dev/lody/commit/ceb3939743ae193ae55949bc36ccc484d658def8))
- let CLI generate session titles
  ([#291](https://github.com/loro-dev/lody/issues/291))
  ([fb01429](https://github.com/loro-dev/lody/commit/fb01429e46c7a16b9eb0b7aa7a604d38e73286bc))
- local session title
  ([293daa3](https://github.com/loro-dev/lody/commit/293daa37b7f45ef749feca4cb2d71d74601aafdd))
- lody do high duration
  ([8a202cd](https://github.com/loro-dev/lody/commit/8a202cd9308e2bb1740df17670d611e7f7f431ae))
- machine reconnect register
  ([b03f088](https://github.com/loro-dev/lody/commit/b03f0884f0b01c1f43caeea2adc1506cb5736b01))
- make cli type safer ([#249](https://github.com/loro-dev/lody/issues/249))
  ([673bded](https://github.com/loro-dev/lody/commit/673bded1c7ba9403b4d9b84c67aaf5d6739a43c3))
- mark terminated machine sessions correctly
  ([#242](https://github.com/loro-dev/lody/issues/242))
  ([c8504bc](https://github.com/loro-dev/lody/commit/c8504bca422a2ceddcd08d129a4bfb96742a0e43))
- merge
  ([8a56f30](https://github.com/loro-dev/lody/commit/8a56f30edf707163ae94b7635c424e833f4db26a))
- module
  ([c5fb124](https://github.com/loro-dev/lody/commit/c5fb12412cc2586b006bfdd0bd4d0943fe7915db))
- never destroy sub
  ([ded2407](https://github.com/loro-dev/lody/commit/ded24071742ebe062a5c6a620a2ea6f50f8e8cd0))
- node ws
  ([d8cf79b](https://github.com/loro-dev/lody/commit/d8cf79b037c0a07a85e96171ec8d8c13b957d6e6))
- prevent uncaught ws error crash
  ([#265](https://github.com/loro-dev/lody/issues/265))
  ([1ae60e5](https://github.com/loro-dev/lody/commit/1ae60e575575133df96074cedafdaa6c0a310a3f))
- re-register machine after reconnect
  ([#266](https://github.com/loro-dev/lody/issues/266))
  ([7b5eba7](https://github.com/loro-dev/lody/commit/7b5eba7a9d4526616f68e060d8220d925fe14f91))
- refine title gen and session start process
  ([#294](https://github.com/loro-dev/lody/issues/294))
  ([37a5504](https://github.com/loro-dev/lody/commit/37a550450833910ed33b0a0c084aa523f009d20c))
- remote machine task
  ([20f1d97](https://github.com/loro-dev/lody/commit/20f1d97b672e08cac1f3dafb9dde6c070e0b3fb0))
- repo
  ([13712c0](https://github.com/loro-dev/lody/commit/13712c0fbd61c5b196e334138a62ab211ceabe54))
- room leave
  ([29f78ea](https://github.com/loro-dev/lody/commit/29f78ea09483a20a290ff83fa2163a75ed9d338f))
- session
  ([f6216ac](https://github.com/loro-dev/lody/commit/f6216ac9e167d72837b365ec6f7246edd2ee31a8))
- session
  ([9a1eb18](https://github.com/loro-dev/lody/commit/9a1eb18a7279fd225d7c200d68068fdb6e0d042f))
- session history be overwritten
  ([#234](https://github.com/loro-dev/lody/issues/234))
  ([5b0b63a](https://github.com/loro-dev/lody/commit/5b0b63a30ce11f283398a674614d36adcaa4ac26))
- session terminated
  ([a291e22](https://github.com/loro-dev/lody/commit/a291e22b508f7edffe480f80dad6f1bd92df8e0b))
- short title ([#330](https://github.com/loro-dev/lody/issues/330))
  ([eec0acc](https://github.com/loro-dev/lody/commit/eec0acc51bfb509d4323a093c0103792241fe476))
- task execution
  ([9f5915c](https://github.com/loro-dev/lody/commit/9f5915c4f770b4d5fa2dabb4a918551f4d44d412))
- ts
  ([3bb6d7f](https://github.com/loro-dev/lody/commit/3bb6d7fcdd5b5fbf7f1dae846581b5d01b989582))
- user chat
  ([ee244ff](https://github.com/loro-dev/lody/commit/ee244ff9e7f1e03cf465563d0a3d1062007e9eac))
- uuidv4
  ([9627873](https://github.com/loro-dev/lody/commit/96278730e76a1dc3cb9da3f13a6be079a8dec33b))
- worktree dir issue ([#288](https://github.com/loro-dev/lody/issues/288))
  ([dec7e2d](https://github.com/loro-dev/lody/commit/dec7e2d085df7ef90fd3126f92224c55695f89e9))
- ws message type
  ([d17e835](https://github.com/loro-dev/lody/commit/d17e835abcfc7827c654107764b59307d9ae9789))
- zod is too strict for message content
  ([#260](https://github.com/loro-dev/lody/issues/260))
  ([b312f6f](https://github.com/loro-dev/lody/commit/b312f6f5f77ea54f45cc43c803b82a384501de8a))
- update DevcontainerSession Git authentication and submodule cloning with HTTPS/SSH
  URL rewriting
  ([d840039](https://github.com/loro-dev/lody/commit/d840039601a0503b5268cff61ed5453e0e94f79c))
- support HTTPS/SSH Git URL rewriting in DevcontainerSession and improve
  LoroWebsocketClient connection handling
  ([518f320](https://github.com/loro-dev/lody/commit/518f32012bfd00c5a98948a38ae0d9d9d0e64687))

### Performance

- speedup applyMessageContents in handle acp update message
  ([#256](https://github.com/loro-dev/lody/issues/256))
  ([a052d3d](https://github.com/loro-dev/lody/commit/a052d3d9e7da3295831a0056417b8dbd2dac9e64))

### Refactors

- make cli testable and fix title extract logics
  ([af85e30](https://github.com/loro-dev/lody/commit/af85e3081cbe6128ef41f2027a237e50cfc6a303))
- migrate loro-mirror history schema to use Any items
  ([fdb3bb1](https://github.com/loro-dev/lody/commit/fdb3bb1a34862799b463d402e838647f3527d8ab))
- remove error handling from ephemeral session updates and streamline session
  management
  ([17e11df](https://github.com/loro-dev/lody/commit/17e11dfc3eec63d1ee05ffd20cc4325fff802956))
- standardize session error handling and update error codes
  ([128a1f9](https://github.com/loro-dev/lody/commit/128a1f99f4344e4e4ed9bcb2be81bc51036451ef))
- update logging and registration logic in agent-client and message-handler
  ([7c248a2](https://github.com/loro-dev/lody/commit/7c248a21f3d10d135bed1c862b8841e350206eb9))

## [0.13.0](https://github.com/loro-dev/lody/compare/lody-cli-v0.12.0...lody-cli-v0.13.0) (2025-12-16)

### Features

- acp
  ([fc0b287](https://github.com/loro-dev/lody/commit/fc0b28764ff8bfe3c38aae10274afa5a1e69d675))
- **acp-history:** persist codex command output as terminal blocks
  ([df4e231](https://github.com/loro-dev/lody/commit/df4e231908092ecff7c7c3026f37ed95565a2cde))
- add command output to history
  ([1fe2009](https://github.com/loro-dev/lody/commit/1fe20095008ff9173f3f3db3586d508d9eff6d0b))
- add machine mode support ([#251](https://github.com/loro-dev/lody/issues/251))
  ([dc39fe9](https://github.com/loro-dev/lody/commit/dc39fe9cb2228f39b5393ce0bb5113fbaa0e83e3))
- add pr webhook reporting and show PR info
  ([#267](https://github.com/loro-dev/lody/issues/267))
  ([0fb67d0](https://github.com/loro-dev/lody/commit/0fb67d0ba0ad4f5299307d8d4d465b669a807a1d))
- add reconnect logic and event handlers for WebSocket connections
  ([#207](https://github.com/loro-dev/lody/issues/207))
  ([f6c823c](https://github.com/loro-dev/lody/commit/f6c823c615c6623992db953d13cac90a6a85fe0d))
- add session chat read status indicator
  ([ed339d8](https://github.com/loro-dev/lody/commit/ed339d8425435e45c993d6d7c94e3b5b9caded5c))
- add session chat read status indicator
  ([c291c75](https://github.com/loro-dev/lody/commit/c291c75e5e5ca976b077a4b3a32839de9e2400a8))
- add session creation dialog 6866ca44
  ([4706b05](https://github.com/loro-dev/lody/commit/4706b0595c4a03138081e73af26d24a172cdf6b0))
- add user metadata to session history
  ([3b54339](https://github.com/loro-dev/lody/commit/3b54339f4796f06c7a8121dcebd275f5b7c6c42b))
- agent config meta
  ([2d8afe4](https://github.com/loro-dev/lody/commit/2d8afe4c53f30417367fb2cc86fd051d31a9998c))
- cli loro repo
  ([f89ba5b](https://github.com/loro-dev/lody/commit/f89ba5b63da0b3d03d42d7bc1ff8757a20fcb38a))
- **cli:** open browser during login
  ([45c8e8b](https://github.com/loro-dev/lody/commit/45c8e8b9bb1ad08010b51868886799c66d35b6cb))
- **cli:** open browser during login
  ([c093d59](https://github.com/loro-dev/lody/commit/c093d59ee081e6691063259b38e0f23426408e62))
- codex resume
  ([59925b6](https://github.com/loro-dev/lody/commit/59925b62034047e8efc6ee43430ce8da5fe96421))
- eph machine
  ([c35a894](https://github.com/loro-dev/lody/commit/c35a894d0b6685f5cb08cca75be50e2fe6771496))
- Generate session titles via local agent on remote creates
  ([#270](https://github.com/loro-dev/lody/issues/270))
  ([0be87f4](https://github.com/loro-dev/lody/commit/0be87f428f5227b91e1b7b2b8b340b61afcd1724))
- introduce LODY_USER_ID and update issue action handling
  ([f485957](https://github.com/loro-dev/lody/commit/f485957e3d327da78f9be7813d444a9cc2391819))
- loro mirror & new convex auth
  ([e1dc473](https://github.com/loro-dev/lody/commit/e1dc4735fa53c73335ebbb8253f14c61be81ebef))
- loro repo
  ([3fbba87](https://github.com/loro-dev/lody/commit/3fbba8755be5321db28ed47ae6d893b4202315b6))
- loro repo issue meta
  ([3c01b46](https://github.com/loro-dev/lody/commit/3c01b4662925973fd0adfbea9d2c054ad06e5eea))
- machine meta
  ([a7dc15a](https://github.com/loro-dev/lody/commit/a7dc15a168dca138d818312cef03d5c71e0b8c86))
- machine meta
  ([2e3620f](https://github.com/loro-dev/lody/commit/2e3620f22e899d8556e3648461ecd763182f4610))
- permission required
  ([a10ef41](https://github.com/loro-dev/lody/commit/a10ef41143aa95189e8919e87182d16aaf6665cd))
- register agent by cli
  ([2cb03d4](https://github.com/loro-dev/lody/commit/2cb03d48338b88de28ed044f2cde060b29e814d8))
- register agent by cli
  ([2536154](https://github.com/loro-dev/lody/commit/253615467580fbebb12c2c85b9d8c75eff07fae1))
- resume session
  ([ff903bd](https://github.com/loro-dev/lody/commit/ff903bd4a08ebda11ac0e077969a7b0b3152ad83))
- single Docker container per repo
  ([#264](https://github.com/loro-dev/lody/issues/264))
  ([b5b4327](https://github.com/loro-dev/lody/commit/b5b4327f57cf6ae5457312b3f8e0d89eafa3e032))
- sync and display ACP plan
  ([#316](https://github.com/loro-dev/lody/issues/316))
  ([d8fc433](https://github.com/loro-dev/lody/commit/d8fc433c4d5669a080f863b8651d9aec3ecab39c))
- sync session startup progress
  ([#296](https://github.com/loro-dev/lody/issues/296))
  ([9620f05](https://github.com/loro-dev/lody/commit/9620f055aa741f97fd7fa17b1d0c67429b38089c))
- terminal bk
  ([346ae5a](https://github.com/loro-dev/lody/commit/346ae5a6187c37ab6348a9b57de65166d7550bb3))
- terminal interface
  ([d59b610](https://github.com/loro-dev/lody/commit/d59b610ca668c5af9b83c8d8600cb97402b3ba05))
- assign agent sessions from task details
  ([4c14e8e](https://github.com/loro-dev/lody/commit/4c14e8e3485895972179de1f4b1e3a8dde80e9bb))

### Bug Fixes

- fix:
  ([898c76d](https://github.com/loro-dev/lody/commit/898c76d84673c4686e9e106aaa5a98107608b54f))
- fix:
  ([955040d](https://github.com/loro-dev/lody/commit/955040dc6f27ca70bac2cf07a2c5b185ad9cd941))
- fix:
  ([1675383](https://github.com/loro-dev/lody/commit/1675383b937889f7fe459e41bde0df9fd8ff2f8c))
- fix:
  ([0eaa185](https://github.com/loro-dev/lody/commit/0eaa1854829a329e1e3022cbfcc392f164c9bfb2))
- add debug logging for session read state
  ([c12cf2a](https://github.com/loro-dev/lody/commit/c12cf2a5db1802aba76dcfadb3242ce19d6cec51))
- add log about the content failed to parse
  ([#258](https://github.com/loro-dev/lody/issues/258))
  ([da70da3](https://github.com/loro-dev/lody/commit/da70da3c36e2c75f55a336eeab3279edd110ad57))
- adjust session termination status
  ([316d549](https://github.com/loro-dev/lody/commit/316d54903132a09f0ac13a8ad72159475caada30))
- agent cli type
  ([f270509](https://github.com/loro-dev/lody/commit/f2705092fc15baa98c84c8ac263074f5fac74b11))
- agent thought
  ([d601320](https://github.com/loro-dev/lody/commit/d601320cec202fab5d4c8bbedd1c7b81616db542))
- background ([#231](https://github.com/loro-dev/lody/issues/231))
  ([63a6f32](https://github.com/loro-dev/lody/commit/63a6f326b271cce0d2cbb37dccf3924d076b6e73))
- chat
  ([cbc9b91](https://github.com/loro-dev/lody/commit/cbc9b91503c301746fff2af70079ee378a4b887d))
- chat ui ([#321](https://github.com/loro-dev/lody/issues/321))
  ([a7caa4b](https://github.com/loro-dev/lody/commit/a7caa4bdef3aa15ae98d648c434b01eaa1134a4c))
- claude
  ([e6f0687](https://github.com/loro-dev/lody/commit/e6f068785f6d3939151a1e48a9f91c317386683c))
- cli
  ([532ca8d](https://github.com/loro-dev/lody/commit/532ca8db961df2186c6048547b5849da51ea9b6f))
- cli
  ([d3832c4](https://github.com/loro-dev/lody/commit/d3832c498ece09f85115666bb9f2d95fb49cfc19))
- cli build
  ([2264da4](https://github.com/loro-dev/lody/commit/2264da4c750cd303de2543b75c1b5be694bd4e5a))
- cli cc codex
  ([bb878af](https://github.com/loro-dev/lody/commit/bb878af3a55f514c545bcdcf9d8b22402e1c1fc5))
- cli codex resume
  ([d0f55ee](https://github.com/loro-dev/lody/commit/d0f55ee13c90e18cbef060b6f9a43862eb7e023d))
- cli session
  ([1a3c5ed](https://github.com/loro-dev/lody/commit/1a3c5ed3bfdec26c5f233f3d9a55f84411bc9e7e))
- cli session
  ([0c99e40](https://github.com/loro-dev/lody/commit/0c99e406394e3d1483b10d5a97de61c1411ba9e6))
- cli type
  ([67b5e9c](https://github.com/loro-dev/lody/commit/67b5e9c5713108e423702f3e057fc453eba7b848))
- **cli:** dedupe replayed thought chunks in history
  ([#314](https://github.com/loro-dev/lody/issues/314))
  ([468f533](https://github.com/loro-dev/lody/commit/468f53382de63f6f2723e7357db3655322fa7f10))
- **cli:** don't hard-exit on unhandledRejection
  ([#318](https://github.com/loro-dev/lody/issues/318))
  ([77ed07f](https://github.com/loro-dev/lody/commit/77ed07fb21f457ceae84685f9c022b656ee20a41))
- **cli:** group agent turn into single history item
  ([#297](https://github.com/loro-dev/lody/issues/297))
  ([af803a8](https://github.com/loro-dev/lody/commit/af803a8831436326fc1eb79b6ef3e08cd6ee4d52))
- **cli:** require plain-text session titles
  ([#310](https://github.com/loro-dev/lody/issues/310))
  ([d9e1d5f](https://github.com/loro-dev/lody/commit/d9e1d5f652a69d56a9f3e163fd970947aa590f32))
- codex option
  ([13d2a00](https://github.com/loro-dev/lody/commit/13d2a0038fa60d4b976c2dd466bc0766c4d3390c))
- codex token ui
  ([fcf7797](https://github.com/loro-dev/lody/commit/fcf7797954a425432529fa7126dec69fddf11f56))
- convex auth
  ([727f25e](https://github.com/loro-dev/lody/commit/727f25ec476a5bf9e45fc4e2dad62cb9785fb047))
- debug log
  ([d6d6e31](https://github.com/loro-dev/lody/commit/d6d6e31f6df1487559e64964b1642f20fb390e4d))
- do
  ([38081bf](https://github.com/loro-dev/lody/commit/38081bff528329d883802ac315c2eafc9b38feb2))
- docker stream
  ([9ab1310](https://github.com/loro-dev/lody/commit/9ab1310058aea38bde74882c4254ba44f5ee6c35))
- docker terminal
  ([164e4f9](https://github.com/loro-dev/lody/commit/164e4f92d5c7c25349d3a9e473c5d3e1459186c5))
- don't need to append pr prompt for each message
  ([2195eb1](https://github.com/loro-dev/lody/commit/2195eb1d840cac56540598df3cc60facba3aefd4))
- eph
  ([8cc43bb](https://github.com/loro-dev/lody/commit/8cc43bb1650727fec87df479ff664cba8e807b11))
- eph err
  ([c3e369d](https://github.com/loro-dev/lody/commit/c3e369d98d3bb43b1132508ccf012ea5a0958d55))
- error
  ([2f9c891](https://github.com/loro-dev/lody/commit/2f9c891564295dfcc4d4998f51a9ede52a5e9fb5))
- find machine by id in do
  ([3a0fbe1](https://github.com/loro-dev/lody/commit/3a0fbe1cd72fa095f90d69bf257d8fd9ca4e5a27))
- handle agent process termination and logging
  ([353fe5f](https://github.com/loro-dev/lody/commit/353fe5f33332ba76e5f9db37de1d16d0d18b6831))
- improve error handling and avoid process being undefined
  ([ceb3939](https://github.com/loro-dev/lody/commit/ceb3939743ae193ae55949bc36ccc484d658def8))
- let CLI generate session titles
  ([#291](https://github.com/loro-dev/lody/issues/291))
  ([fb01429](https://github.com/loro-dev/lody/commit/fb01429e46c7a16b9eb0b7aa7a604d38e73286bc))
- local session title
  ([293daa3](https://github.com/loro-dev/lody/commit/293daa37b7f45ef749feca4cb2d71d74601aafdd))
- lody do high duration
  ([8a202cd](https://github.com/loro-dev/lody/commit/8a202cd9308e2bb1740df17670d611e7f7f431ae))
- machine reconnect register
  ([b03f088](https://github.com/loro-dev/lody/commit/b03f0884f0b01c1f43caeea2adc1506cb5736b01))
- make cli type safer ([#249](https://github.com/loro-dev/lody/issues/249))
  ([673bded](https://github.com/loro-dev/lody/commit/673bded1c7ba9403b4d9b84c67aaf5d6739a43c3))
- mark terminated machine sessions correctly
  ([#242](https://github.com/loro-dev/lody/issues/242))
  ([c8504bc](https://github.com/loro-dev/lody/commit/c8504bca422a2ceddcd08d129a4bfb96742a0e43))
- merge
  ([8a56f30](https://github.com/loro-dev/lody/commit/8a56f30edf707163ae94b7635c424e833f4db26a))
- module
  ([c5fb124](https://github.com/loro-dev/lody/commit/c5fb12412cc2586b006bfdd0bd4d0943fe7915db))
- never destroy sub
  ([ded2407](https://github.com/loro-dev/lody/commit/ded24071742ebe062a5c6a620a2ea6f50f8e8cd0))
- node ws
  ([d8cf79b](https://github.com/loro-dev/lody/commit/d8cf79b037c0a07a85e96171ec8d8c13b957d6e6))
- prevent uncaught ws error crash
  ([#265](https://github.com/loro-dev/lody/issues/265))
  ([1ae60e5](https://github.com/loro-dev/lody/commit/1ae60e575575133df96074cedafdaa6c0a310a3f))
- re-register machine after reconnect
  ([#266](https://github.com/loro-dev/lody/issues/266))
  ([7b5eba7](https://github.com/loro-dev/lody/commit/7b5eba7a9d4526616f68e060d8220d925fe14f91))
- refine title gen and session start process
  ([#294](https://github.com/loro-dev/lody/issues/294))
  ([37a5504](https://github.com/loro-dev/lody/commit/37a550450833910ed33b0a0c084aa523f009d20c))
- remote machine task
  ([20f1d97](https://github.com/loro-dev/lody/commit/20f1d97b672e08cac1f3dafb9dde6c070e0b3fb0))
- repo
  ([13712c0](https://github.com/loro-dev/lody/commit/13712c0fbd61c5b196e334138a62ab211ceabe54))
- room leave
  ([29f78ea](https://github.com/loro-dev/lody/commit/29f78ea09483a20a290ff83fa2163a75ed9d338f))
- session
  ([f6216ac](https://github.com/loro-dev/lody/commit/f6216ac9e167d72837b365ec6f7246edd2ee31a8))
- session
  ([9a1eb18](https://github.com/loro-dev/lody/commit/9a1eb18a7279fd225d7c200d68068fdb6e0d042f))
- session history be overwritten
  ([#234](https://github.com/loro-dev/lody/issues/234))
  ([5b0b63a](https://github.com/loro-dev/lody/commit/5b0b63a30ce11f283398a674614d36adcaa4ac26))
- session terminated
  ([a291e22](https://github.com/loro-dev/lody/commit/a291e22b508f7edffe480f80dad6f1bd92df8e0b))
- short title ([#330](https://github.com/loro-dev/lody/issues/330))
  ([eec0acc](https://github.com/loro-dev/lody/commit/eec0acc51bfb509d4323a093c0103792241fe476))
- task execution
  ([9f5915c](https://github.com/loro-dev/lody/commit/9f5915c4f770b4d5fa2dabb4a918551f4d44d412))
- ts
  ([3bb6d7f](https://github.com/loro-dev/lody/commit/3bb6d7fcdd5b5fbf7f1dae846581b5d01b989582))
- user chat
  ([ee244ff](https://github.com/loro-dev/lody/commit/ee244ff9e7f1e03cf465563d0a3d1062007e9eac))
- uuidv4
  ([9627873](https://github.com/loro-dev/lody/commit/96278730e76a1dc3cb9da3f13a6be079a8dec33b))
- worktree dir issue ([#288](https://github.com/loro-dev/lody/issues/288))
  ([dec7e2d](https://github.com/loro-dev/lody/commit/dec7e2d085df7ef90fd3126f92224c55695f89e9))
- zod is too strict for message content
  ([#260](https://github.com/loro-dev/lody/issues/260))
  ([b312f6f](https://github.com/loro-dev/lody/commit/b312f6f5f77ea54f45cc43c803b82a384501de8a))
- update DevcontainerSession Git authentication and submodule cloning with HTTPS/SSH
  URL rewriting
  ([d840039](https://github.com/loro-dev/lody/commit/d840039601a0503b5268cff61ed5453e0e94f79c))
- support HTTPS/SSH Git URL rewriting in DevcontainerSession and improve
  LoroWebsocketClient connection handling
  ([518f320](https://github.com/loro-dev/lody/commit/518f32012bfd00c5a98948a38ae0d9d9d0e64687))

### Performance

- speedup applyMessageContents in handle acp update message
  ([#256](https://github.com/loro-dev/lody/issues/256))
  ([a052d3d](https://github.com/loro-dev/lody/commit/a052d3d9e7da3295831a0056417b8dbd2dac9e64))

### Refactors

- make cli testable and fix title extract logics
  ([af85e30](https://github.com/loro-dev/lody/commit/af85e3081cbe6128ef41f2027a237e50cfc6a303))
- migrate loro-mirror history schema to use Any items
  ([fdb3bb1](https://github.com/loro-dev/lody/commit/fdb3bb1a34862799b463d402e838647f3527d8ab))
- remove error handling from ephemeral session updates and streamline session
  management
  ([17e11df](https://github.com/loro-dev/lody/commit/17e11dfc3eec63d1ee05ffd20cc4325fff802956))
- standardize session error handling and update error codes
  ([128a1f9](https://github.com/loro-dev/lody/commit/128a1f99f4344e4e4ed9bcb2be81bc51036451ef))
- update logging and registration logic in agent-client and message-handler
  ([7c248a2](https://github.com/loro-dev/lody/commit/7c248a21f3d10d135bed1c862b8841e350206eb9))

## [0.11.0](https://github.com/loro-dev/lody/compare/lody-cli-v0.10.0...lody-cli-v0.11.0) (2025-12-15)

### Features

- sync and display ACP plan
  ([#316](https://github.com/loro-dev/lody/issues/316))
  ([d8fc433](https://github.com/loro-dev/lody/commit/d8fc433c4d5669a080f863b8651d9aec3ecab39c))

### Bug Fixes

- chat ui ([#321](https://github.com/loro-dev/lody/issues/321))
  ([a7caa4b](https://github.com/loro-dev/lody/commit/a7caa4bdef3aa15ae98d648c434b01eaa1134a4c))
- **cli:** dedupe replayed thought chunks in history
  ([#314](https://github.com/loro-dev/lody/issues/314))
  ([468f533](https://github.com/loro-dev/lody/commit/468f53382de63f6f2723e7357db3655322fa7f10))
- **cli:** don't hard-exit on unhandledRejection
  ([#318](https://github.com/loro-dev/lody/issues/318))
  ([77ed07f](https://github.com/loro-dev/lody/commit/77ed07fb21f457ceae84685f9c022b656ee20a41))
- **cli:** require plain-text session titles
  ([#310](https://github.com/loro-dev/lody/issues/310))
  ([d9e1d5f](https://github.com/loro-dev/lody/commit/d9e1d5f652a69d56a9f3e163fd970947aa590f32))

## [0.10.0](https://github.com/loro-dev/lody/compare/lody-cli-v0.9.3...lody-cli-v0.10.0) (2025-12-14)

### Features

- sync session startup progress
  ([#296](https://github.com/loro-dev/lody/issues/296))
  ([9620f05](https://github.com/loro-dev/lody/commit/9620f055aa741f97fd7fa17b1d0c67429b38089c))

### Bug Fixes

- **cli:** group agent turn into single history item
  ([#297](https://github.com/loro-dev/lody/issues/297))
  ([af803a8](https://github.com/loro-dev/lody/commit/af803a8831436326fc1eb79b6ef3e08cd6ee4d52))

## [0.9.3](https://github.com/loro-dev/lody/compare/lody-cli-v0.9.2...lody-cli-v0.9.3) (2025-12-14)

### Bug Fixes

- don't need to append pr prompt for each message
  ([2195eb1](https://github.com/loro-dev/lody/commit/2195eb1d840cac56540598df3cc60facba3aefd4))
- refine title gen and session start process
  ([#294](https://github.com/loro-dev/lody/issues/294))
  ([37a5504](https://github.com/loro-dev/lody/commit/37a550450833910ed33b0a0c084aa523f009d20c))

## [0.9.2](https://github.com/loro-dev/lody/compare/lody-cli-v0.9.1...lody-cli-v0.9.2) (2025-12-13)

### Bug Fixes

- let CLI generate session titles
  ([#291](https://github.com/loro-dev/lody/issues/291))
  ([fb01429](https://github.com/loro-dev/lody/commit/fb01429e46c7a16b9eb0b7aa7a604d38e73286bc))

## [0.9.1](https://github.com/loro-dev/lody/compare/lody-cli-v0.9.0...lody-cli-v0.9.1) (2025-12-13)

### Bug Fixes

- worktree dir issue ([#288](https://github.com/loro-dev/lody/issues/288))
  ([dec7e2d](https://github.com/loro-dev/lody/commit/dec7e2d085df7ef90fd3126f92224c55695f89e9))

## [0.9.0](https://github.com/loro-dev/lody/compare/lody-cli-v0.8.0...lody-cli-v0.9.0) (2025-12-13)

### Features

- **acp-history:** persist codex command output as terminal blocks
  ([df4e231](https://github.com/loro-dev/lody/commit/df4e231908092ecff7c7c3026f37ed95565a2cde))
- add command output to history
  ([1fe2009](https://github.com/loro-dev/lody/commit/1fe20095008ff9173f3f3db3586d508d9eff6d0b))

### Refactors

- make cli testable and fix title extract logics
  ([af85e30](https://github.com/loro-dev/lody/commit/af85e3081cbe6128ef41f2027a237e50cfc6a303))
- migrate loro-mirror history schema to use Any items
  ([fdb3bb1](https://github.com/loro-dev/lody/commit/fdb3bb1a34862799b463d402e838647f3527d8ab))

## [0.8.0](https://github.com/loro-dev/lody/compare/lody-cli-v0.7.0...lody-cli-v0.8.0) (2025-12-12)

### Features

- single Docker container per repo
  ([#264](https://github.com/loro-dev/lody/issues/264))
  ([b5b4327](https://github.com/loro-dev/lody/commit/b5b4327f57cf6ae5457312b3f8e0d89eafa3e032))

## [0.7.0](https://github.com/loro-dev/lody/compare/lody-cli-v0.6.0...lody-cli-v0.7.0) (2025-12-12)

### Features

- Generate session titles via local agent on remote creates
  ([#270](https://github.com/loro-dev/lody/issues/270))
  ([0be87f4](https://github.com/loro-dev/lody/commit/0be87f428f5227b91e1b7b2b8b340b61afcd1724))

## [0.6.0](https://github.com/loro-dev/lody/compare/lody-cli-v0.5.0...lody-cli-v0.6.0) (2025-12-11)

### Features

- add pr webhook reporting and show PR info
  ([#267](https://github.com/loro-dev/lody/issues/267))
  ([0fb67d0](https://github.com/loro-dev/lody/commit/0fb67d0ba0ad4f5299307d8d4d465b669a807a1d))

## [0.5.0](https://github.com/loro-dev/lody/compare/lody-cli-v0.4.3...lody-cli-v0.5.0) (2025-12-11)

### Features

- add machine mode support ([#251](https://github.com/loro-dev/lody/issues/251))
  ([dc39fe9](https://github.com/loro-dev/lody/commit/dc39fe9cb2228f39b5393ce0bb5113fbaa0e83e3))

### Bug Fixes

- prevent uncaught ws error crash
  ([#265](https://github.com/loro-dev/lody/issues/265))
  ([1ae60e5](https://github.com/loro-dev/lody/commit/1ae60e575575133df96074cedafdaa6c0a310a3f))
- re-register machine after reconnect
  ([#266](https://github.com/loro-dev/lody/issues/266))
  ([7b5eba7](https://github.com/loro-dev/lody/commit/7b5eba7a9d4526616f68e060d8220d925fe14f91))

## [0.4.3](https://github.com/loro-dev/lody/compare/lody-cli-v0.4.2...lody-cli-v0.4.3) (2025-12-09)

### Bug Fixes

- zod is too strict for message content
  ([#260](https://github.com/loro-dev/lody/issues/260))
  ([b312f6f](https://github.com/loro-dev/lody/commit/b312f6f5f77ea54f45cc43c803b82a384501de8a))

## [0.4.2](https://github.com/loro-dev/lody/compare/lody-cli-v0.4.1...lody-cli-v0.4.2) (2025-12-09)

### Bug Fixes

- add log about the content failed to parse
  ([#258](https://github.com/loro-dev/lody/issues/258))
  ([da70da3](https://github.com/loro-dev/lody/commit/da70da3c36e2c75f55a336eeab3279edd110ad57))

## [0.4.1](https://github.com/loro-dev/lody/compare/lody-cli-v0.4.0...lody-cli-v0.4.1) (2025-12-09)

### Performance

- speedup applyMessageContents in handle acp update message
  ([#256](https://github.com/loro-dev/lody/issues/256))
  ([a052d3d](https://github.com/loro-dev/lody/commit/a052d3d9e7da3295831a0056417b8dbd2dac9e64))

## [0.4.0](https://github.com/loro-dev/lody/compare/lody-cli-v0.3.0...lody-cli-v0.4.0) (2025-12-09)

### Features

- acp
  ([fc0b287](https://github.com/loro-dev/lody/commit/fc0b28764ff8bfe3c38aae10274afa5a1e69d675))
- add reconnect logic and event handlers for WebSocket connections
  ([#207](https://github.com/loro-dev/lody/issues/207))
  ([f6c823c](https://github.com/loro-dev/lody/commit/f6c823c615c6623992db953d13cac90a6a85fe0d))
- add session chat read status indicator
  ([ed339d8](https://github.com/loro-dev/lody/commit/ed339d8425435e45c993d6d7c94e3b5b9caded5c))
- add session chat read status indicator
  ([c291c75](https://github.com/loro-dev/lody/commit/c291c75e5e5ca976b077a4b3a32839de9e2400a8))
- add session creation dialog 6866ca44
  ([4706b05](https://github.com/loro-dev/lody/commit/4706b0595c4a03138081e73af26d24a172cdf6b0))
- add user metadata to session history
  ([3b54339](https://github.com/loro-dev/lody/commit/3b54339f4796f06c7a8121dcebd275f5b7c6c42b))
- agent config
  ([12716f1](https://github.com/loro-dev/lody/commit/12716f1a85e77fc083390e959b25ad2f2269f4b3))
- agent config meta
  ([2d8afe4](https://github.com/loro-dev/lody/commit/2d8afe4c53f30417367fb2cc86fd051d31a9998c))
- cli change issue status
  ([fb46da1](https://github.com/loro-dev/lody/commit/fb46da192d751d5c52fedcec34b6fe3d82bc04d2))
- cli loro repo
  ([f89ba5b](https://github.com/loro-dev/lody/commit/f89ba5b63da0b3d03d42d7bc1ff8757a20fcb38a))
- **cli:** open browser during login
  ([45c8e8b](https://github.com/loro-dev/lody/commit/45c8e8b9bb1ad08010b51868886799c66d35b6cb))
- **cli:** open browser during login
  ([c093d59](https://github.com/loro-dev/lody/commit/c093d59ee081e6691063259b38e0f23426408e62))
- codex
  ([1fb943f](https://github.com/loro-dev/lody/commit/1fb943f3d72ac4504173b8f9ec0f012b1fb467d0))
- codex resume
  ([59925b6](https://github.com/loro-dev/lody/commit/59925b62034047e8efc6ee43430ce8da5fe96421))
- eph machine
  ([c35a894](https://github.com/loro-dev/lody/commit/c35a894d0b6685f5cb08cca75be50e2fe6771496))
- introduce LODY_USER_ID and update issue action handling
  ([f485957](https://github.com/loro-dev/lody/commit/f485957e3d327da78f9be7813d444a9cc2391819))
- loro mirror
  ([4ea57bd](https://github.com/loro-dev/lody/commit/4ea57bd6af87de3760ba7ffafc5e0fc6d6daf1db))
- loro mirror & new convex auth
  ([e1dc473](https://github.com/loro-dev/lody/commit/e1dc4735fa53c73335ebbb8253f14c61be81ebef))
- loro repo
  ([3fbba87](https://github.com/loro-dev/lody/commit/3fbba8755be5321db28ed47ae6d893b4202315b6))
- loro repo issue meta
  ([3c01b46](https://github.com/loro-dev/lody/commit/3c01b4662925973fd0adfbea9d2c054ad06e5eea))
- machine meta
  ([a7dc15a](https://github.com/loro-dev/lody/commit/a7dc15a168dca138d818312cef03d5c71e0b8c86))
- machine meta
  ([2e3620f](https://github.com/loro-dev/lody/commit/2e3620f22e899d8556e3648461ecd763182f4610))
- permission required
  ([a10ef41](https://github.com/loro-dev/lody/commit/a10ef41143aa95189e8919e87182d16aaf6665cd))
- register agent by cli
  ([2cb03d4](https://github.com/loro-dev/lody/commit/2cb03d48338b88de28ed044f2cde060b29e814d8))
- register agent by cli
  ([2536154](https://github.com/loro-dev/lody/commit/253615467580fbebb12c2c85b9d8c75eff07fae1))
- resume session
  ([ff903bd](https://github.com/loro-dev/lody/commit/ff903bd4a08ebda11ac0e077969a7b0b3152ad83))
- terminal bk
  ([346ae5a](https://github.com/loro-dev/lody/commit/346ae5a6187c37ab6348a9b57de65166d7550bb3))
- terminal interface
  ([d59b610](https://github.com/loro-dev/lody/commit/d59b610ca668c5af9b83c8d8600cb97402b3ba05))
- update loro mirror
  ([4d01deb](https://github.com/loro-dev/lody/commit/4d01debabb6e2623282b81ab6e3d0d3f13136026))
- assign agent sessions from task details
  ([4c14e8e](https://github.com/loro-dev/lody/commit/4c14e8e3485895972179de1f4b1e3a8dde80e9bb))
- implement workspace label management
  ([31d7d21](https://github.com/loro-dev/lody/commit/31d7d216507389166b325f2235977fb243aaf2fc))
- add Codex support
  ([013b728](https://github.com/loro-dev/lody/commit/013b728bebd3bde736968e5d7f4c20b6039447b3))

### Bug Fixes

- fix:
  ([898c76d](https://github.com/loro-dev/lody/commit/898c76d84673c4686e9e106aaa5a98107608b54f))
- fix:
  ([955040d](https://github.com/loro-dev/lody/commit/955040dc6f27ca70bac2cf07a2c5b185ad9cd941))
- fix:
  ([1675383](https://github.com/loro-dev/lody/commit/1675383b937889f7fe459e41bde0df9fd8ff2f8c))
- fix:
  ([0eaa185](https://github.com/loro-dev/lody/commit/0eaa1854829a329e1e3022cbfcc392f164c9bfb2))
- add debug logging for session read state
  ([c12cf2a](https://github.com/loro-dev/lody/commit/c12cf2a5db1802aba76dcfadb3242ce19d6cec51))
- adjust session termination status
  ([316d549](https://github.com/loro-dev/lody/commit/316d54903132a09f0ac13a8ad72159475caada30))
- agent cli type
  ([f270509](https://github.com/loro-dev/lody/commit/f2705092fc15baa98c84c8ac263074f5fac74b11))
- agent state
  ([da0badd](https://github.com/loro-dev/lody/commit/da0baddd2c777777d89ab7902c675000406acacd))
- agent thought
  ([d601320](https://github.com/loro-dev/lody/commit/d601320cec202fab5d4c8bbedd1c7b81616db542))
- background ([#231](https://github.com/loro-dev/lody/issues/231))
  ([63a6f32](https://github.com/loro-dev/lody/commit/63a6f326b271cce0d2cbb37dccf3924d076b6e73))
- chat
  ([cbc9b91](https://github.com/loro-dev/lody/commit/cbc9b91503c301746fff2af70079ee378a4b887d))
- claude
  ([e6f0687](https://github.com/loro-dev/lody/commit/e6f068785f6d3939151a1e48a9f91c317386683c))
- cli
  ([532ca8d](https://github.com/loro-dev/lody/commit/532ca8db961df2186c6048547b5849da51ea9b6f))
- cli
  ([d3832c4](https://github.com/loro-dev/lody/commit/d3832c498ece09f85115666bb9f2d95fb49cfc19))
- cli build
  ([2264da4](https://github.com/loro-dev/lody/commit/2264da4c750cd303de2543b75c1b5be694bd4e5a))
- cli cc codex
  ([bb878af](https://github.com/loro-dev/lody/commit/bb878af3a55f514c545bcdcf9d8b22402e1c1fc5))
- cli cliType
  ([3b6ca0d](https://github.com/loro-dev/lody/commit/3b6ca0db0b122fc27e17a27143e5995ed46b595d))
- cli codex resume
  ([d0f55ee](https://github.com/loro-dev/lody/commit/d0f55ee13c90e18cbef060b6f9a43862eb7e023d))
- cli issue history
  ([f7ae374](https://github.com/loro-dev/lody/commit/f7ae374da820ea9c3e11b18fcc3f493f3d603258))
- cli package
  ([b14fe39](https://github.com/loro-dev/lody/commit/b14fe399e178355661143c5642263e220af466a0))
- cli session
  ([1a3c5ed](https://github.com/loro-dev/lody/commit/1a3c5ed3bfdec26c5f233f3d9a55f84411bc9e7e))
- cli session
  ([0c99e40](https://github.com/loro-dev/lody/commit/0c99e406394e3d1483b10d5a97de61c1411ba9e6))
- cli type
  ([67b5e9c](https://github.com/loro-dev/lody/commit/67b5e9c5713108e423702f3e057fc453eba7b848))
- add automatic CLI WebSocket reconnection
  ([30c201c](https://github.com/loro-dev/lody/commit/30c201cf0c7c016db1bcb6cce260bbb96bdcfbf5))
- client cli
  ([6934ea0](https://github.com/loro-dev/lody/commit/6934ea0c603ff2b221f2af388a300bcb4a8ce863))
- **cli:** optimize status update logging and prevent unnecessary updates
  ([7b15dd8](https://github.com/loro-dev/lody/commit/7b15dd8fe6c02263dd8fbc1743de3e981172ffc4))
- codex mount
  ([19f7239](https://github.com/loro-dev/lody/commit/19f72396b33e6581574541d51bca64ffa4170a4c))
- codex option
  ([13d2a00](https://github.com/loro-dev/lody/commit/13d2a0038fa60d4b976c2dd466bc0766c4d3390c))
- codex token ui
  ([fcf7797](https://github.com/loro-dev/lody/commit/fcf7797954a425432529fa7126dec69fddf11f56))
- convex auth
  ([727f25e](https://github.com/loro-dev/lody/commit/727f25ec476a5bf9e45fc4e2dad62cb9785fb047))
- debug log
  ([d6d6e31](https://github.com/loro-dev/lody/commit/d6d6e31f6df1487559e64964b1642f20fb390e4d))
- do
  ([38081bf](https://github.com/loro-dev/lody/commit/38081bff528329d883802ac315c2eafc9b38feb2))
- docker stream
  ([9ab1310](https://github.com/loro-dev/lody/commit/9ab1310058aea38bde74882c4254ba44f5ee6c35))
- docker terminal
  ([164e4f9](https://github.com/loro-dev/lody/commit/164e4f92d5c7c25349d3a9e473c5d3e1459186c5))
- eph
  ([8cc43bb](https://github.com/loro-dev/lody/commit/8cc43bb1650727fec87df479ff664cba8e807b11))
- eph err
  ([c3e369d](https://github.com/loro-dev/lody/commit/c3e369d98d3bb43b1132508ccf012ea5a0958d55))
- error
  ([2f9c891](https://github.com/loro-dev/lody/commit/2f9c891564295dfcc4d4998f51a9ede52a5e9fb5))
- find machine by id in do
  ([3a0fbe1](https://github.com/loro-dev/lody/commit/3a0fbe1cd72fa095f90d69bf257d8fd9ca4e5a27))
- handle agent process termination and logging
  ([353fe5f](https://github.com/loro-dev/lody/commit/353fe5f33332ba76e5f9db37de1d16d0d18b6831))
- improve error handling and avoid process being undefined
  ([ceb3939](https://github.com/loro-dev/lody/commit/ceb3939743ae193ae55949bc36ccc484d658def8))
- **issues:** handle deleted sessions in action history and show session status
  icon
  ([ccc5247](https://github.com/loro-dev/lody/commit/ccc5247770919e7973cca73c36f461d14e837cc5))
- local session title
  ([293daa3](https://github.com/loro-dev/lody/commit/293daa37b7f45ef749feca4cb2d71d74601aafdd))
- lody do high duration
  ([8a202cd](https://github.com/loro-dev/lody/commit/8a202cd9308e2bb1740df17670d611e7f7f431ae))
- machine reconnect register
  ([b03f088](https://github.com/loro-dev/lody/commit/b03f0884f0b01c1f43caeea2adc1506cb5736b01))
- make cli type safer ([#249](https://github.com/loro-dev/lody/issues/249))
  ([673bded](https://github.com/loro-dev/lody/commit/673bded1c7ba9403b4d9b84c67aaf5d6739a43c3))
- mark terminated machine sessions correctly
  ([#242](https://github.com/loro-dev/lody/issues/242))
  ([c8504bc](https://github.com/loro-dev/lody/commit/c8504bca422a2ceddcd08d129a4bfb96742a0e43))
- merge
  ([8a56f30](https://github.com/loro-dev/lody/commit/8a56f30edf707163ae94b7635c424e833f4db26a))
- module
  ([c5fb124](https://github.com/loro-dev/lody/commit/c5fb12412cc2586b006bfdd0bd4d0943fe7915db))
- never destroy sub
  ([ded2407](https://github.com/loro-dev/lody/commit/ded24071742ebe062a5c6a620a2ea6f50f8e8cd0))
- node ws
  ([d8cf79b](https://github.com/loro-dev/lody/commit/d8cf79b037c0a07a85e96171ec8d8c13b957d6e6))
- pnpm workspace
  ([33c0ebb](https://github.com/loro-dev/lody/commit/33c0ebb396d4bf041be12cb94a1be4211c76ff7f))
- remote machine task
  ([20f1d97](https://github.com/loro-dev/lody/commit/20f1d97b672e08cac1f3dafb9dde6c070e0b3fb0))
- repo
  ([13712c0](https://github.com/loro-dev/lody/commit/13712c0fbd61c5b196e334138a62ab211ceabe54))
- room leave
  ([29f78ea](https://github.com/loro-dev/lody/commit/29f78ea09483a20a290ff83fa2163a75ed9d338f))
- session
  ([f6216ac](https://github.com/loro-dev/lody/commit/f6216ac9e167d72837b365ec6f7246edd2ee31a8))
- session
  ([9a1eb18](https://github.com/loro-dev/lody/commit/9a1eb18a7279fd225d7c200d68068fdb6e0d042f))
- session history be overwritten
  ([#234](https://github.com/loro-dev/lody/issues/234))
  ([5b0b63a](https://github.com/loro-dev/lody/commit/5b0b63a30ce11f283398a674614d36adcaa4ac26))
- session terminated
  ([a291e22](https://github.com/loro-dev/lody/commit/a291e22b508f7edffe480f80dad6f1bd92df8e0b))
- task execution
  ([9f5915c](https://github.com/loro-dev/lody/commit/9f5915c4f770b4d5fa2dabb4a918551f4d44d412))
- ts
  ([3bb6d7f](https://github.com/loro-dev/lody/commit/3bb6d7fcdd5b5fbf7f1dae846581b5d01b989582))
- use loro for label
  ([e51e2ea](https://github.com/loro-dev/lody/commit/e51e2ea5530e24e73eb2c014c3259d9f6682651b))
- use string for session history
  ([dc3e204](https://github.com/loro-dev/lody/commit/dc3e204669f31df43323d097028a81e3b94561fa))
- user chat
  ([ee244ff](https://github.com/loro-dev/lody/commit/ee244ff9e7f1e03cf465563d0a3d1062007e9eac))
- uuidv4
  ([9627873](https://github.com/loro-dev/lody/commit/96278730e76a1dc3cb9da3f13a6be079a8dec33b))
- ws connect
  ([f338704](https://github.com/loro-dev/lody/commit/f3387041cafe21e875044c51ea7d137602678085))
- fix CLI cloning for repositories with submodules
  ([226d49a](https://github.com/loro-dev/lody/commit/226d49aad6f0b76947623fa2910187e3248ed509))
- fix CLI cloning for repositories with submodules
  ([16224d3](https://github.com/loro-dev/lody/commit/16224d349340a44cba18eab15842e377967949c4))
- improve cleanup of CLI Git submodule clone configuration
  ([5ccc50c](https://github.com/loro-dev/lody/commit/5ccc50cc0eb0ae7ef460ebb9b2669fba62d93c74))
- update DevcontainerSession Git authentication and submodule cloning with HTTPS/SSH
  URL rewriting
  ([d840039](https://github.com/loro-dev/lody/commit/d840039601a0503b5268cff61ed5453e0e94f79c))
- support HTTPS/SSH Git URL rewriting in DevcontainerSession and improve
  LoroWebsocketClient connection handling
  ([518f320](https://github.com/loro-dev/lody/commit/518f32012bfd00c5a98948a38ae0d9d9d0e64687))

### Refactors

- **cli:** replace console.log with logger across apps/cli
  ([1e75b40](https://github.com/loro-dev/lody/commit/1e75b40b6b85b782c80f9d97f3cbc7c199f05c5a))
- remove error handling from ephemeral session updates and streamline session
  management
  ([17e11df](https://github.com/loro-dev/lody/commit/17e11dfc3eec63d1ee05ffd20cc4325fff802956))
- standardize session error handling and update error codes
  ([128a1f9](https://github.com/loro-dev/lody/commit/128a1f99f4344e4e4ed9bcb2be81bc51036451ef))
- update logging and registration logic in agent-client and message-handler
  ([7c248a2](https://github.com/loro-dev/lody/commit/7c248a21f3d10d135bed1c862b8841e350206eb9))

## [0.3.0](https://github.com/loro-dev/lody/compare/lody-cli-v0.2.8...lody-cli-v0.3.0) (2025-12-09)

### Features

- acp
  ([fc0b287](https://github.com/loro-dev/lody/commit/fc0b28764ff8bfe3c38aae10274afa5a1e69d675))
- add reconnect logic and event handlers for WebSocket connections
  ([#207](https://github.com/loro-dev/lody/issues/207))
  ([f6c823c](https://github.com/loro-dev/lody/commit/f6c823c615c6623992db953d13cac90a6a85fe0d))
- add session chat read status indicator
  ([ed339d8](https://github.com/loro-dev/lody/commit/ed339d8425435e45c993d6d7c94e3b5b9caded5c))
- add session chat read status indicator
  ([c291c75](https://github.com/loro-dev/lody/commit/c291c75e5e5ca976b077a4b3a32839de9e2400a8))
- add session creation dialog 6866ca44
  ([4706b05](https://github.com/loro-dev/lody/commit/4706b0595c4a03138081e73af26d24a172cdf6b0))
- add user metadata to session history
  ([3b54339](https://github.com/loro-dev/lody/commit/3b54339f4796f06c7a8121dcebd275f5b7c6c42b))
- agent config
  ([12716f1](https://github.com/loro-dev/lody/commit/12716f1a85e77fc083390e959b25ad2f2269f4b3))
- agent config meta
  ([2d8afe4](https://github.com/loro-dev/lody/commit/2d8afe4c53f30417367fb2cc86fd051d31a9998c))
- cli change issue status
  ([fb46da1](https://github.com/loro-dev/lody/commit/fb46da192d751d5c52fedcec34b6fe3d82bc04d2))
- cli loro repo
  ([f89ba5b](https://github.com/loro-dev/lody/commit/f89ba5b63da0b3d03d42d7bc1ff8757a20fcb38a))
- **cli:** open browser during login
  ([45c8e8b](https://github.com/loro-dev/lody/commit/45c8e8b9bb1ad08010b51868886799c66d35b6cb))
- **cli:** open browser during login
  ([c093d59](https://github.com/loro-dev/lody/commit/c093d59ee081e6691063259b38e0f23426408e62))
- codex
  ([1fb943f](https://github.com/loro-dev/lody/commit/1fb943f3d72ac4504173b8f9ec0f012b1fb467d0))
- codex resume
  ([59925b6](https://github.com/loro-dev/lody/commit/59925b62034047e8efc6ee43430ce8da5fe96421))
- eph machine
  ([c35a894](https://github.com/loro-dev/lody/commit/c35a894d0b6685f5cb08cca75be50e2fe6771496))
- introduce LODY_USER_ID and update issue action handling
  ([f485957](https://github.com/loro-dev/lody/commit/f485957e3d327da78f9be7813d444a9cc2391819))
- loro mirror
  ([4ea57bd](https://github.com/loro-dev/lody/commit/4ea57bd6af87de3760ba7ffafc5e0fc6d6daf1db))
- loro mirror & new convex auth
  ([e1dc473](https://github.com/loro-dev/lody/commit/e1dc4735fa53c73335ebbb8253f14c61be81ebef))
- loro repo
  ([3fbba87](https://github.com/loro-dev/lody/commit/3fbba8755be5321db28ed47ae6d893b4202315b6))
- loro repo issue meta
  ([3c01b46](https://github.com/loro-dev/lody/commit/3c01b4662925973fd0adfbea9d2c054ad06e5eea))
- machine meta
  ([a7dc15a](https://github.com/loro-dev/lody/commit/a7dc15a168dca138d818312cef03d5c71e0b8c86))
- machine meta
  ([2e3620f](https://github.com/loro-dev/lody/commit/2e3620f22e899d8556e3648461ecd763182f4610))
- permission required
  ([a10ef41](https://github.com/loro-dev/lody/commit/a10ef41143aa95189e8919e87182d16aaf6665cd))
- register agent by cli
  ([2cb03d4](https://github.com/loro-dev/lody/commit/2cb03d48338b88de28ed044f2cde060b29e814d8))
- register agent by cli
  ([2536154](https://github.com/loro-dev/lody/commit/253615467580fbebb12c2c85b9d8c75eff07fae1))
- resume session
  ([ff903bd](https://github.com/loro-dev/lody/commit/ff903bd4a08ebda11ac0e077969a7b0b3152ad83))
- terminal bk
  ([346ae5a](https://github.com/loro-dev/lody/commit/346ae5a6187c37ab6348a9b57de65166d7550bb3))
- terminal interface
  ([d59b610](https://github.com/loro-dev/lody/commit/d59b610ca668c5af9b83c8d8600cb97402b3ba05))
- update loro mirror
  ([4d01deb](https://github.com/loro-dev/lody/commit/4d01debabb6e2623282b81ab6e3d0d3f13136026))
- assign agent sessions from task details
  ([4c14e8e](https://github.com/loro-dev/lody/commit/4c14e8e3485895972179de1f4b1e3a8dde80e9bb))
- implement workspace label management
  ([31d7d21](https://github.com/loro-dev/lody/commit/31d7d216507389166b325f2235977fb243aaf2fc))
- add Codex support
  ([013b728](https://github.com/loro-dev/lody/commit/013b728bebd3bde736968e5d7f4c20b6039447b3))

### Bug Fixes

- fix:
  ([898c76d](https://github.com/loro-dev/lody/commit/898c76d84673c4686e9e106aaa5a98107608b54f))
- fix:
  ([955040d](https://github.com/loro-dev/lody/commit/955040dc6f27ca70bac2cf07a2c5b185ad9cd941))
- fix:
  ([1675383](https://github.com/loro-dev/lody/commit/1675383b937889f7fe459e41bde0df9fd8ff2f8c))
- fix:
  ([0eaa185](https://github.com/loro-dev/lody/commit/0eaa1854829a329e1e3022cbfcc392f164c9bfb2))
- add debug logging for session read state
  ([c12cf2a](https://github.com/loro-dev/lody/commit/c12cf2a5db1802aba76dcfadb3242ce19d6cec51))
- adjust session termination status
  ([316d549](https://github.com/loro-dev/lody/commit/316d54903132a09f0ac13a8ad72159475caada30))
- agent cli type
  ([f270509](https://github.com/loro-dev/lody/commit/f2705092fc15baa98c84c8ac263074f5fac74b11))
- agent state
  ([da0badd](https://github.com/loro-dev/lody/commit/da0baddd2c777777d89ab7902c675000406acacd))
- agent thought
  ([d601320](https://github.com/loro-dev/lody/commit/d601320cec202fab5d4c8bbedd1c7b81616db542))
- background ([#231](https://github.com/loro-dev/lody/issues/231))
  ([63a6f32](https://github.com/loro-dev/lody/commit/63a6f326b271cce0d2cbb37dccf3924d076b6e73))
- chat
  ([cbc9b91](https://github.com/loro-dev/lody/commit/cbc9b91503c301746fff2af70079ee378a4b887d))
- claude
  ([e6f0687](https://github.com/loro-dev/lody/commit/e6f068785f6d3939151a1e48a9f91c317386683c))
- cli
  ([532ca8d](https://github.com/loro-dev/lody/commit/532ca8db961df2186c6048547b5849da51ea9b6f))
- cli
  ([d3832c4](https://github.com/loro-dev/lody/commit/d3832c498ece09f85115666bb9f2d95fb49cfc19))
- cli build
  ([2264da4](https://github.com/loro-dev/lody/commit/2264da4c750cd303de2543b75c1b5be694bd4e5a))
- cli cc codex
  ([bb878af](https://github.com/loro-dev/lody/commit/bb878af3a55f514c545bcdcf9d8b22402e1c1fc5))
- cli cliType
  ([3b6ca0d](https://github.com/loro-dev/lody/commit/3b6ca0db0b122fc27e17a27143e5995ed46b595d))
- cli codex resume
  ([d0f55ee](https://github.com/loro-dev/lody/commit/d0f55ee13c90e18cbef060b6f9a43862eb7e023d))
- cli issue history
  ([f7ae374](https://github.com/loro-dev/lody/commit/f7ae374da820ea9c3e11b18fcc3f493f3d603258))
- cli package
  ([b14fe39](https://github.com/loro-dev/lody/commit/b14fe399e178355661143c5642263e220af466a0))
- cli session
  ([1a3c5ed](https://github.com/loro-dev/lody/commit/1a3c5ed3bfdec26c5f233f3d9a55f84411bc9e7e))
- cli session
  ([0c99e40](https://github.com/loro-dev/lody/commit/0c99e406394e3d1483b10d5a97de61c1411ba9e6))
- cli type
  ([67b5e9c](https://github.com/loro-dev/lody/commit/67b5e9c5713108e423702f3e057fc453eba7b848))
- add automatic CLI WebSocket reconnection
  ([30c201c](https://github.com/loro-dev/lody/commit/30c201cf0c7c016db1bcb6cce260bbb96bdcfbf5))
- client cli
  ([6934ea0](https://github.com/loro-dev/lody/commit/6934ea0c603ff2b221f2af388a300bcb4a8ce863))
- **cli:** optimize status update logging and prevent unnecessary updates
  ([7b15dd8](https://github.com/loro-dev/lody/commit/7b15dd8fe6c02263dd8fbc1743de3e981172ffc4))
- codex mount
  ([19f7239](https://github.com/loro-dev/lody/commit/19f72396b33e6581574541d51bca64ffa4170a4c))
- codex option
  ([13d2a00](https://github.com/loro-dev/lody/commit/13d2a0038fa60d4b976c2dd466bc0766c4d3390c))
- codex token ui
  ([fcf7797](https://github.com/loro-dev/lody/commit/fcf7797954a425432529fa7126dec69fddf11f56))
- convex auth
  ([727f25e](https://github.com/loro-dev/lody/commit/727f25ec476a5bf9e45fc4e2dad62cb9785fb047))
- debug log
  ([d6d6e31](https://github.com/loro-dev/lody/commit/d6d6e31f6df1487559e64964b1642f20fb390e4d))
- do
  ([38081bf](https://github.com/loro-dev/lody/commit/38081bff528329d883802ac315c2eafc9b38feb2))
- docker stream
  ([9ab1310](https://github.com/loro-dev/lody/commit/9ab1310058aea38bde74882c4254ba44f5ee6c35))
- docker terminal
  ([164e4f9](https://github.com/loro-dev/lody/commit/164e4f92d5c7c25349d3a9e473c5d3e1459186c5))
- eph
  ([8cc43bb](https://github.com/loro-dev/lody/commit/8cc43bb1650727fec87df479ff664cba8e807b11))
- eph err
  ([c3e369d](https://github.com/loro-dev/lody/commit/c3e369d98d3bb43b1132508ccf012ea5a0958d55))
- error
  ([2f9c891](https://github.com/loro-dev/lody/commit/2f9c891564295dfcc4d4998f51a9ede52a5e9fb5))
- find machine by id in do
  ([3a0fbe1](https://github.com/loro-dev/lody/commit/3a0fbe1cd72fa095f90d69bf257d8fd9ca4e5a27))
- handle agent process termination and logging
  ([353fe5f](https://github.com/loro-dev/lody/commit/353fe5f33332ba76e5f9db37de1d16d0d18b6831))
- improve error handling and avoid process being undefined
  ([ceb3939](https://github.com/loro-dev/lody/commit/ceb3939743ae193ae55949bc36ccc484d658def8))
- **issues:** handle deleted sessions in action history and show session status
  icon
  ([ccc5247](https://github.com/loro-dev/lody/commit/ccc5247770919e7973cca73c36f461d14e837cc5))
- local session title
  ([293daa3](https://github.com/loro-dev/lody/commit/293daa37b7f45ef749feca4cb2d71d74601aafdd))
- lody do high duration
  ([8a202cd](https://github.com/loro-dev/lody/commit/8a202cd9308e2bb1740df17670d611e7f7f431ae))
- machine reconnect register
  ([b03f088](https://github.com/loro-dev/lody/commit/b03f0884f0b01c1f43caeea2adc1506cb5736b01))
- make cli type safer ([#249](https://github.com/loro-dev/lody/issues/249))
  ([673bded](https://github.com/loro-dev/lody/commit/673bded1c7ba9403b4d9b84c67aaf5d6739a43c3))
- mark terminated machine sessions correctly
  ([#242](https://github.com/loro-dev/lody/issues/242))
  ([c8504bc](https://github.com/loro-dev/lody/commit/c8504bca422a2ceddcd08d129a4bfb96742a0e43))
- merge
  ([8a56f30](https://github.com/loro-dev/lody/commit/8a56f30edf707163ae94b7635c424e833f4db26a))
- module
  ([c5fb124](https://github.com/loro-dev/lody/commit/c5fb12412cc2586b006bfdd0bd4d0943fe7915db))
- never destroy sub
  ([ded2407](https://github.com/loro-dev/lody/commit/ded24071742ebe062a5c6a620a2ea6f50f8e8cd0))
- node ws
  ([d8cf79b](https://github.com/loro-dev/lody/commit/d8cf79b037c0a07a85e96171ec8d8c13b957d6e6))
- pnpm workspace
  ([33c0ebb](https://github.com/loro-dev/lody/commit/33c0ebb396d4bf041be12cb94a1be4211c76ff7f))
- remote machine task
  ([20f1d97](https://github.com/loro-dev/lody/commit/20f1d97b672e08cac1f3dafb9dde6c070e0b3fb0))
- repo
  ([13712c0](https://github.com/loro-dev/lody/commit/13712c0fbd61c5b196e334138a62ab211ceabe54))
- room leave
  ([29f78ea](https://github.com/loro-dev/lody/commit/29f78ea09483a20a290ff83fa2163a75ed9d338f))
- session
  ([f6216ac](https://github.com/loro-dev/lody/commit/f6216ac9e167d72837b365ec6f7246edd2ee31a8))
- session
  ([9a1eb18](https://github.com/loro-dev/lody/commit/9a1eb18a7279fd225d7c200d68068fdb6e0d042f))
- session history be overwritten
  ([#234](https://github.com/loro-dev/lody/issues/234))
  ([5b0b63a](https://github.com/loro-dev/lody/commit/5b0b63a30ce11f283398a674614d36adcaa4ac26))
- session terminated
  ([a291e22](https://github.com/loro-dev/lody/commit/a291e22b508f7edffe480f80dad6f1bd92df8e0b))
- task execution
  ([9f5915c](https://github.com/loro-dev/lody/commit/9f5915c4f770b4d5fa2dabb4a918551f4d44d412))
- ts
  ([3bb6d7f](https://github.com/loro-dev/lody/commit/3bb6d7fcdd5b5fbf7f1dae846581b5d01b989582))
- use loro for label
  ([e51e2ea](https://github.com/loro-dev/lody/commit/e51e2ea5530e24e73eb2c014c3259d9f6682651b))
- use string for session history
  ([dc3e204](https://github.com/loro-dev/lody/commit/dc3e204669f31df43323d097028a81e3b94561fa))
- user chat
  ([ee244ff](https://github.com/loro-dev/lody/commit/ee244ff9e7f1e03cf465563d0a3d1062007e9eac))
- uuidv4
  ([9627873](https://github.com/loro-dev/lody/commit/96278730e76a1dc3cb9da3f13a6be079a8dec33b))
- ws connect
  ([f338704](https://github.com/loro-dev/lody/commit/f3387041cafe21e875044c51ea7d137602678085))
- fix CLI cloning for repositories with submodules
  ([226d49a](https://github.com/loro-dev/lody/commit/226d49aad6f0b76947623fa2910187e3248ed509))
- fix CLI cloning for repositories with submodules
  ([16224d3](https://github.com/loro-dev/lody/commit/16224d349340a44cba18eab15842e377967949c4))
- improve cleanup of CLI Git submodule clone configuration
  ([5ccc50c](https://github.com/loro-dev/lody/commit/5ccc50cc0eb0ae7ef460ebb9b2669fba62d93c74))
- update DevcontainerSession Git authentication and submodule cloning with HTTPS/SSH
  URL rewriting
  ([d840039](https://github.com/loro-dev/lody/commit/d840039601a0503b5268cff61ed5453e0e94f79c))
- support HTTPS/SSH Git URL rewriting in DevcontainerSession and improve
  LoroWebsocketClient connection handling
  ([518f320](https://github.com/loro-dev/lody/commit/518f32012bfd00c5a98948a38ae0d9d9d0e64687))

### Refactors

- **cli:** replace console.log with logger across apps/cli
  ([1e75b40](https://github.com/loro-dev/lody/commit/1e75b40b6b85b782c80f9d97f3cbc7c199f05c5a))
- remove error handling from ephemeral session updates and streamline session
  management
  ([17e11df](https://github.com/loro-dev/lody/commit/17e11dfc3eec63d1ee05ffd20cc4325fff802956))
- standardize session error handling and update error codes
  ([128a1f9](https://github.com/loro-dev/lody/commit/128a1f99f4344e4e4ed9bcb2be81bc51036451ef))
- update logging and registration logic in agent-client and message-handler
  ([7c248a2](https://github.com/loro-dev/lody/commit/7c248a21f3d10d135bed1c862b8841e350206eb9))
