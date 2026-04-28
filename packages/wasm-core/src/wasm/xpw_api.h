#ifndef XPW_API_H
#define XPW_API_H

#ifdef __cplusplus
extern "C" {
#endif

int xpw_boot(void);
const char *xpw_load_model(const char *ode_text, const char *file_name);
const char *xpw_get_model_info(void);
const char *xpw_run_simulation(const char *request_json);
const char *xpw_run_phase_plane(const char *request_json);
const char *xpw_run_bifurcation(const char *request_json);
void xpw_free(void);

#ifdef __cplusplus
}
#endif

#endif
