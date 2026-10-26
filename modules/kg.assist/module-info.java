/** Local code assistant: model seal, sandboxed engine, scope guard and the write-check-fix loop. */
module kg.assist {
    requires transitive kg.core;
    requires transitive kg.verdict;
    requires transitive kg.harness;
    requires transitive kg.sil;
    exports kg.assist;
}
