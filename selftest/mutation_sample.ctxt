#include "fw_ctrl.h"

#define KP        0.15f
#define KI        0.02f
#define INTEG_MAX 60.0f

#define TASK_READ 1u
#define TASK_CTRL 2u
#define TASK_OUT  4u

static float clampf(float v, float lo, float hi)
{
    if (v < lo) { return lo; }
    if (v > hi) { return hi; }
    return v;
}

uint32_t fw_abi_version(void) { return 2u; }
uint32_t fw_n_in(void)        { return FW_N_IN; }
uint32_t fw_n_out(void)       { return FW_N_OUT; }
uint32_t fw_state_size(void)  { return (uint32_t)sizeof(fw_state_t); }

void fw_init(fw_state_t *s)
{
    s->integ = 0.0f;
    s->mode = FW_RUN;
    s->done_mask = 0u;
}

void fw_step(fw_state_t *s, const float *in, float *out)
{
    float setpoint = in[0];
    float sensor_c = in[1];
    float duty = 0.0f;

    s->done_mask = 0u;

    /* Task 1: read and validate the sensor. An open sensor latches a fault. */
    if (sensor_c <= FW_SENSOR_OPEN_C) {
        s->mode = FW_FAULT_SENSOR;
    }
    s->done_mask |= TASK_READ;

    /* Task 2: control law (PI with conditional-integration anti-windup). */
    if (s->mode == FW_RUN) {
        if (sensor_c >= FW_TEMP_HARD_CUT_C) {
            s->integ = 0.0f;
            duty = 0.0f;
        } else {
            float err = setpoint - sensor_c;
            float next = clampf(s->integ + (err * FW_DT_S), 0.0f, INTEG_MAX);
            float u = (KP * err) + (KI * next);
            if (!(((u > 1.0f) && (err > 0.0f)) || ((u < 0.0f) && (err < 0.0f)))) {
                s->integ = next;
            }
            duty = (KP * err) + (KI * s->integ);
        }
    }
    s->done_mask |= TASK_CTRL;

    /* Task 3: output stage, always clamped to the safe range. */
    out[0] = clampf(duty, 0.0f, 1.0f);
    s->done_mask |= TASK_OUT;
}

uint32_t fw_progress_token(const fw_state_t *s, uint32_t tick)
{
    return ((tick + 1u) << 3) | (s->done_mask & 7u);
}
