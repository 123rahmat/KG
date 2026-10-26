#ifndef FW_VALVE_H
#define FW_VALVE_H

#include <stdint.h>

/* Valve positioner, Kindgleam firmware ABI v2, 1 kHz.
 * in[0] target %, in[1] enable 0/1, in[2] position %;  out[0] drive -1..1 */
#define FW_N_IN  3u
#define FW_N_OUT 1u

#define FW_POS_MIN_VALID  (-10.0f)  /* REQ-003: readings outside this band mean a broken sensor */
#define FW_POS_MAX_VALID  110.0f
#define FW_SPRING_GAIN    150.0f    /* % of travel per unit drive at standstill */
#define FW_DT_S           0.001f

typedef struct {
    float    integ;
    float    last_pos;
    uint32_t fault;
    uint32_t started;
    uint32_t done_mask;
} fw_state_t;

uint32_t fw_abi_version(void);
uint32_t fw_n_in(void);
uint32_t fw_n_out(void);
uint32_t fw_state_size(void);
void     fw_init(fw_state_t *s);
void     fw_step(fw_state_t *s, const float *in, float *out);
uint32_t fw_progress_token(const fw_state_t *s, uint32_t tick);

#endif
