#ifndef KG_PIL_TARGET_H
#define KG_PIL_TARGET_H

/*
 * On-chip PIL handler. Receives link frames, runs the engineer's firmware one tick per STEP,
 * and answers. Same behaviour as the simulated board (kg.rig.VirtualBoard), which is how
 * Kindgleam checks that PIL on real silicon matches SIL tick for tick.
 *
 * Works with any firmware written to Kindgleam firmware ABI v2 (FW_N_IN, FW_N_OUT, fw_step(in, out)).
 * Board port supplies these (one small file per board):
 */
#include <stdint.h>

uint32_t kg_port_chip_id(void);                          /* e.g. DBGMCU->IDCODE & 0xFFF */
void     kg_port_uart_write(const uint8_t *p, uint16_t n);
void     kg_port_watchdog_kick(uint32_t token);          /* independent hardware watchdog */
uint8_t  kg_port_watchdog_tripped(void);                 /* 1 if the last reset came from the watchdog */
void     kg_port_outputs_safe(void);                     /* force every output to its safe level */
uint32_t kg_port_step_cycles_ns(void);                   /* duration of the last fw_step in ns (e.g. from DWT->CYCCNT) */

extern const char    kg_board_name[];                    /* must match BOARD in board.cfg */
extern const char    kg_board_rev[];
extern const uint8_t kg_firmware_hash[32];               /* SHA-256 of the image, filled in at build */

void kg_pil_init(void);
void kg_pil_on_byte(uint8_t b);                          /* call for each received UART byte */

#endif
