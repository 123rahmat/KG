#ifndef FW_CTRL_H
#define FW_CTRL_H

#include <stdint.h>

/* Heater controller firmware, Kindgleam firmware ABI v2. Runs at 200 Hz. Static memory only.
 * in[0]  setpoint  C     (command)
 * in[1]  sensor    C     (temperature sensor)
 * out[0] heater    0..1  (PWM duty)                                                       */

#define FW_N_IN  2u
#define FW_N_OUT 1u

#define FW_TEMP_HARD_CUT_C  90.0f   /* REQ-005: output forced to 0 at or above this */
#define FW_SENSOR_OPEN_C   (-40.0f) /* REQ-004: reading at or below this means open circuit */
#define FW_DT_S              0.005f

typedef enum { FW_RUN = 0, FW_FAULT_SENSOR = 1 } fw_mode_t;

typedef struct {
    float     integ;
    fw_mode_t mode;
    uint32_t  done_mask;  /* tasks completed this cycle, proves progress to the watchdog */
} fw_state_t;

uint32_t fw_abi_version(void);
uint32_t fw_n_in(void);
uint32_t fw_n_out(void);
uint32_t fw_state_size(void);
void     fw_init(fw_state_t *s);
void     fw_step(fw_state_t *s, const float *in, float *out);
uint32_t fw_progress_token(const fw_state_t *s, uint32_t tick);

#endif
