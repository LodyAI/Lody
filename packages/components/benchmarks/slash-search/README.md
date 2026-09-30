# Slash command ranking evaluation

Run from `packages/components` with the repository's supported Node version:

```sh
node --experimental-strip-types benchmarks/slash-search/eval.mjs
```

[The evaluator](eval.mjs) compares the previous Prompt Shortcut group and
alphabetical ordering with the shared ranking implementation. Ten synthetic
queries have an explicitly judged top result and graded relevance for NDCG@5.
The evaluator asserts each new top result, reports both orders and aggregate
quality, then times 100 pure filter-and-rank runs over 1,000 synthetic entries.
The timing includes no React rendering, network activity, availability lookup,
or actual user catalog. Samples and judgments are inspectable in the script;
they measure these scenarios rather than production search quality.
