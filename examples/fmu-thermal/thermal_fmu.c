/* Minimal FMI 2.0 Co-Simulation FMU: first-order thermal plant.
 * Variables: u (input, heater 0..1, vr 0), d (input, disturbance C/s, vr 1), T (output, C, vr 2).
 * T' = (-(T - 25) + 200 u) / 10 + d, integrated with forward Euler at the requested step. */
#include <stddef.h>
#include <string.h>

typedef void *fmi2Component;
typedef unsigned int fmi2ValueReference;
typedef double fmi2Real;
typedef int fmi2Integer;
typedef int fmi2Boolean;
typedef const char *fmi2String;
typedef enum { fmi2OK, fmi2Warning, fmi2Discard, fmi2Error, fmi2Fatal, fmi2Pending } fmi2Status;
typedef enum { fmi2ModelExchange, fmi2CoSimulation } fmi2Type;
typedef struct {
    void (*logger)(void *, fmi2String, fmi2Status, fmi2String, fmi2String, ...);
    void *(*allocateMemory)(size_t, size_t);
    void (*freeMemory)(void *);
    void (*stepFinished)(void *, fmi2Status);
    void *componentEnvironment;
} fmi2CallbackFunctions;

typedef struct {
    double u, d, T;
    const fmi2CallbackFunctions *cb;
} inst_t;

#define EXPORT __attribute__((visibility("default")))

EXPORT fmi2Component fmi2Instantiate(fmi2String name, fmi2Type type, fmi2String guid, fmi2String res,
                                     const fmi2CallbackFunctions *f, fmi2Boolean vis, fmi2Boolean log)
{
    (void)name; (void)res; (void)vis; (void)log;
    if (type != fmi2CoSimulation || guid == NULL || strcmp(guid, "{kindgleam-thermal-0001}") != 0) {
        return NULL;
    }
    inst_t *c = (inst_t *)f->allocateMemory(1, sizeof(inst_t));
    if (c == NULL) {
        return NULL;
    }
    c->u = 0.0; c->d = 0.0; c->T = 25.0; c->cb = f;
    return c;
}
EXPORT fmi2Status fmi2SetupExperiment(fmi2Component c, fmi2Boolean a, fmi2Real b, fmi2Real t0, fmi2Boolean e, fmi2Real t1)
{ (void)c; (void)a; (void)b; (void)t0; (void)e; (void)t1; return fmi2OK; }
EXPORT fmi2Status fmi2EnterInitializationMode(fmi2Component c) { (void)c; return fmi2OK; }
EXPORT fmi2Status fmi2ExitInitializationMode(fmi2Component c) { (void)c; return fmi2OK; }
EXPORT fmi2Status fmi2SetReal(fmi2Component c, const fmi2ValueReference vr[], size_t n, const fmi2Real v[])
{
    inst_t *s = (inst_t *)c;
    for (size_t i = 0; i < n; i++) {
        if (vr[i] == 0) { s->u = v[i]; } else if (vr[i] == 1) { s->d = v[i]; } else { return fmi2Error; }
    }
    return fmi2OK;
}
EXPORT fmi2Status fmi2GetReal(fmi2Component c, const fmi2ValueReference vr[], size_t n, fmi2Real v[])
{
    inst_t *s = (inst_t *)c;
    for (size_t i = 0; i < n; i++) {
        if (vr[i] == 2) { v[i] = s->T; } else if (vr[i] == 0) { v[i] = s->u; } else if (vr[i] == 1) { v[i] = s->d; }
        else { return fmi2Error; }
    }
    return fmi2OK;
}
EXPORT fmi2Status fmi2DoStep(fmi2Component c, fmi2Real t, fmi2Real h, fmi2Boolean noSet)
{
    (void)t; (void)noSet;
    inst_t *s = (inst_t *)c;
    s->T += ((-(s->T - 25.0) + 200.0 * s->u) / 10.0 + s->d) * h;
    return fmi2OK;
}
EXPORT void fmi2FreeInstance(fmi2Component c)
{
    inst_t *s = (inst_t *)c;
    if (s != NULL) { s->cb->freeMemory(s); }
}
