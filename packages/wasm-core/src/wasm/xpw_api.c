#include "xpw_api.h"

#include <ctype.h>
#include <errno.h>
#include <math.h>
#include <stdarg.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/stat.h>

#include "auto_nox.h"
#include "diagram.h"
#include "form_ode.h"
#include "integrate.h"
#include "load_eqn.h"
#include "main.h"
#include "my_rhs.h"
#include "parserslow.h"
#include "xpplim.h"

#ifndef XPP_WASM_HEADLESS
#define XPP_WASM_HEADLESS 1
#endif

#define XPW_MAX_KEY 64
#define XPW_MAX_NAME 64
#define XPW_MAX_PAIRS 256

typedef struct {
  char key[XPW_MAX_KEY];
  double value;
} XpwKvPair;

typedef struct {
  char *data;
  size_t len;
  size_t cap;
} XpwStringBuilder;

extern int got_file;
extern int METHOD;
extern int NJMP;
extern int NUPAR;
extern int NODE;
extern int NEQ;
extern int NMarkov;
extern int Naux;
extern int NAutoPar;
extern int AutoPar[20];
extern int tfBell;
extern BIFUR Auto;

extern float **storage;
extern int storind;

extern double T0;
extern double TEND;
extern double DELTA_T;
extern double TRANS;
extern double last_ic[MAXODE];

extern char this_file[XPP_MAX_NAME];
extern char uvar_names[MAXODE][12];
extern char upar_names[MAXPAR][11];
extern char aux_names[MAXODE][12];

extern DIAGRAM *bifd;
extern GRABPT grabpt;

extern int yes_reset_auto(void);

static char *xpw_last_json = NULL;
static char *xpw_loaded_ode = NULL;
static char *xpw_loaded_name = NULL;
static int xpw_model_ready = 0;
static int xpw_model_counter = 0;

static int xpw_is_finite(double value) {
  return !(isnan(value) || isinf(value));
}

static const char *xpw_set_json(const char *json) {
  size_t n;
  if (xpw_last_json != NULL) {
    free(xpw_last_json);
    xpw_last_json = NULL;
  }
  if (json == NULL) {
    return NULL;
  }
  n = strlen(json);
  xpw_last_json = (char *)malloc(n + 1);
  if (xpw_last_json == NULL) {
    return "{\"error\":\"allocation_failed\"}";
  }
  memcpy(xpw_last_json, json, n + 1);
  return xpw_last_json;
}

static void xpw_store_loaded_copy(const char *ode_text, const char *file_name) {
  size_t n;
  if (xpw_loaded_ode != NULL) {
    free(xpw_loaded_ode);
    xpw_loaded_ode = NULL;
  }
  if (xpw_loaded_name != NULL) {
    free(xpw_loaded_name);
    xpw_loaded_name = NULL;
  }
  if (ode_text != NULL) {
    n = strlen(ode_text);
    xpw_loaded_ode = (char *)malloc(n + 1);
    if (xpw_loaded_ode != NULL) {
      memcpy(xpw_loaded_ode, ode_text, n + 1);
    }
  }
  if (file_name != NULL) {
    n = strlen(file_name);
    xpw_loaded_name = (char *)malloc(n + 1);
    if (xpw_loaded_name != NULL) {
      memcpy(xpw_loaded_name, file_name, n + 1);
    }
  }
}

static int xpw_sb_init(XpwStringBuilder *sb, size_t initial_cap) {
  sb->data = (char *)malloc(initial_cap);
  if (sb->data == NULL) {
    sb->len = 0;
    sb->cap = 0;
    return 0;
  }
  sb->data[0] = '\0';
  sb->len = 0;
  sb->cap = initial_cap;
  return 1;
}

static int xpw_sb_reserve(XpwStringBuilder *sb, size_t extra) {
  char *next;
  size_t need;
  size_t cap;
  if (sb->len + extra + 1 <= sb->cap) {
    return 1;
  }
  need = sb->len + extra + 1;
  cap = sb->cap == 0 ? 1024 : sb->cap;
  while (cap < need) {
    cap *= 2;
  }
  next = (char *)realloc(sb->data, cap);
  if (next == NULL) {
    return 0;
  }
  sb->data = next;
  sb->cap = cap;
  return 1;
}

static int xpw_sb_append_raw(XpwStringBuilder *sb, const char *text) {
  size_t n;
  if (text == NULL) {
    return 1;
  }
  n = strlen(text);
  if (!xpw_sb_reserve(sb, n)) {
    return 0;
  }
  memcpy(sb->data + sb->len, text, n + 1);
  sb->len += n;
  return 1;
}

static int xpw_sb_appendf(XpwStringBuilder *sb, const char *fmt, ...) {
  va_list args;
  va_list copy;
  int n;
  if (fmt == NULL) {
    return 1;
  }
  va_start(args, fmt);
  va_copy(copy, args);
  n = vsnprintf(NULL, 0, fmt, copy);
  va_end(copy);
  if (n < 0) {
    va_end(args);
    return 0;
  }
  if (!xpw_sb_reserve(sb, (size_t)n)) {
    va_end(args);
    return 0;
  }
  vsnprintf(sb->data + sb->len, sb->cap - sb->len, fmt, args);
  va_end(args);
  sb->len += (size_t)n;
  return 1;
}

static int xpw_sb_append_json_string(XpwStringBuilder *sb, const char *text) {
  const char *p;
  if (!xpw_sb_append_raw(sb, "\"")) {
    return 0;
  }
  if (text != NULL) {
    for (p = text; *p != '\0'; ++p) {
      unsigned char c;
      c = (unsigned char)(*p);
      if (c == '"' || c == '\\') {
        if (!xpw_sb_appendf(sb, "\\%c", c)) {
          return 0;
        }
      } else if (c == '\n') {
        if (!xpw_sb_append_raw(sb, "\\n")) {
          return 0;
        }
      } else if (c == '\r') {
        if (!xpw_sb_append_raw(sb, "\\r")) {
          return 0;
        }
      } else if (c == '\t') {
        if (!xpw_sb_append_raw(sb, "\\t")) {
          return 0;
        }
      } else if (c < 32) {
        if (!xpw_sb_appendf(sb, "\\u%04x", (unsigned int)c)) {
          return 0;
        }
      } else {
        if (!xpw_sb_appendf(sb, "%c", c)) {
          return 0;
        }
      }
    }
  }
  return xpw_sb_append_raw(sb, "\"");
}

static void xpw_sb_free(XpwStringBuilder *sb) {
  if (sb->data != NULL) {
    free(sb->data);
    sb->data = NULL;
  }
  sb->len = 0;
  sb->cap = 0;
}

static const char *xpw_skip_ws(const char *p) {
  while (p != NULL && *p != '\0' && isspace((unsigned char)*p)) {
    ++p;
  }
  return p;
}

static const char *xpw_find_key_value_start(const char *json, const char *key) {
  char needle[128];
  const char *p;
  snprintf(needle, sizeof(needle), "\"%s\"", key);
  p = strstr(json, needle);
  if (p == NULL) {
    return NULL;
  }
  p = strchr(p + strlen(needle), ':');
  if (p == NULL) {
    return NULL;
  }
  ++p;
  return xpw_skip_ws(p);
}

static int xpw_parse_string(const char *json, const char *key, char *out, size_t out_len) {
  const char *p;
  size_t n;
  if (out_len == 0) {
    return 0;
  }
  out[0] = '\0';
  p = xpw_find_key_value_start(json, key);
  if (p == NULL || *p != '"') {
    return 0;
  }
  ++p;
  n = 0;
  while (*p != '\0' && *p != '"') {
    if (*p == '\\' && p[1] != '\0') {
      ++p;
    }
    if (n + 1 < out_len) {
      out[n++] = *p;
    }
    ++p;
  }
  out[n] = '\0';
  return *p == '"';
}

static int xpw_parse_double(const char *json, const char *key, double *out) {
  const char *p;
  char *endptr;
  double v;
  p = xpw_find_key_value_start(json, key);
  if (p == NULL) {
    return 0;
  }
  errno = 0;
  v = strtod(p, &endptr);
  if (endptr == p || errno != 0) {
    return 0;
  }
  *out = v;
  return 1;
}

static int xpw_parse_int(const char *json, const char *key, int *out) {
  double v;
  if (!xpw_parse_double(json, key, &v)) {
    return 0;
  }
  *out = (int)v;
  return 1;
}

static int xpw_parse_bool(const char *json, const char *key, int *out) {
  const char *p;
  p = xpw_find_key_value_start(json, key);
  if (p == NULL) {
    return 0;
  }
  if (strncmp(p, "true", 4) == 0) {
    *out = 1;
    return 1;
  }
  if (strncmp(p, "false", 5) == 0) {
    *out = 0;
    return 1;
  }
  return 0;
}

static int xpw_parse_numeric_map(const char *json, const char *map_key, XpwKvPair *pairs, int max_pairs) {
  const char *p;
  int count;
  count = 0;
  p = xpw_find_key_value_start(json, map_key);
  if (p == NULL || *p != '{') {
    return 0;
  }
  ++p;
  while (*p != '\0') {
    const char *name_start;
    const char *name_end;
    size_t name_len;
    char *endptr;
    double value;

    p = xpw_skip_ws(p);
    if (*p == ',') {
      ++p;
      continue;
    }
    if (*p == '}') {
      break;
    }
    if (*p != '"') {
      break;
    }

    name_start = ++p;
    while (*p != '\0' && *p != '"') {
      if (*p == '\\' && p[1] != '\0') {
        ++p;
      }
      ++p;
    }
    if (*p != '"') {
      break;
    }
    name_end = p;
    ++p;
    p = xpw_skip_ws(p);
    if (*p != ':') {
      break;
    }
    ++p;
    p = xpw_skip_ws(p);

    errno = 0;
    value = strtod(p, &endptr);
    if (endptr == p || errno != 0) {
      break;
    }

    if (count < max_pairs) {
      name_len = (size_t)(name_end - name_start);
      if (name_len >= XPW_MAX_KEY) {
        name_len = XPW_MAX_KEY - 1;
      }
      memcpy(pairs[count].key, name_start, name_len);
      pairs[count].key[name_len] = '\0';
      pairs[count].value = value;
      ++count;
    }

    p = endptr;
    p = xpw_skip_ws(p);
    if (*p == ',') {
      ++p;
    }
  }
  return count;
}

static int xpw_ieq(const char *a, const char *b) {
  int ca;
  int cb;
  if (a == NULL || b == NULL) {
    return 0;
  }
  while (*a != '\0' && *b != '\0') {
    ca = tolower((unsigned char)*a);
    cb = tolower((unsigned char)*b);
    if (ca != cb) {
      return 0;
    }
    ++a;
    ++b;
  }
  return *a == '\0' && *b == '\0';
}

static int xpw_find_state_index(const char *name) {
  int i;
  for (i = 0; i < NODE + NMarkov && i < MAXODE; ++i) {
    if (xpw_ieq(name, uvar_names[i])) {
      return i;
    }
  }
  return -1;
}

static int xpw_find_param_index(const char *name) {
  int i;
  for (i = 0; i < NUPAR && i < MAXPAR; ++i) {
    if (xpw_ieq(name, upar_names[i])) {
      return i;
    }
  }
  return -1;
}

static int xpw_find_auto_slot_for_param(const char *name) {
  int i;
  for (i = 0; i < NAutoPar; ++i) {
    int param_index;
    param_index = AutoPar[i];
    if (param_index >= 0 && param_index < NUPAR && xpw_ieq(name, upar_names[param_index])) {
      return i;
    }
  }
  return -1;
}

static void xpw_apply_parameter_overrides(const char *json) {
  XpwKvPair pairs[XPW_MAX_PAIRS];
  int i;
  int n;
  n = xpw_parse_numeric_map(json, "parameterOverrides", pairs, XPW_MAX_PAIRS);
  for (i = 0; i < n; ++i) {
    set_val(pairs[i].key, pairs[i].value);
  }
}

static void xpw_apply_initial_conditions(const char *json) {
  XpwKvPair pairs[XPW_MAX_PAIRS];
  int i;
  int idx;
  int n;
  n = xpw_parse_numeric_map(json, "initialConditions", pairs, XPW_MAX_PAIRS);
  for (i = 0; i < n; ++i) {
    idx = xpw_find_state_index(pairs[i].key);
    if (idx >= 0 && idx < MAXODE) {
      last_ic[idx] = pairs[i].value;
      set_val(uvar_names[idx], pairs[i].value);
    }
  }
}

static void xpw_apply_fixed_state(const char *json, double *state) {
  XpwKvPair pairs[XPW_MAX_PAIRS];
  int i;
  int idx;
  int n;
  n = xpw_parse_numeric_map(json, "fixedState", pairs, XPW_MAX_PAIRS);
  for (i = 0; i < n; ++i) {
    idx = xpw_find_state_index(pairs[i].key);
    if (idx >= 0 && idx < NODE) {
      state[idx] = pairs[i].value;
    }
  }
}

static int xpw_method_from_name(const char *name) {
  if (xpw_ieq(name, "discrete")) {
    return 0;
  }
  if (xpw_ieq(name, "euler")) {
    return 1;
  }
  if (xpw_ieq(name, "modified_euler")) {
    return 2;
  }
  if (xpw_ieq(name, "rk4")) {
    return 3;
  }
  if (xpw_ieq(name, "adams")) {
    return 4;
  }
  if (xpw_ieq(name, "gear")) {
    return 5;
  }
  if (xpw_ieq(name, "cvode")) {
    return 10;
  }
  return METHOD;
}

static int xpw_write_model_file(const char *ode_text, const char *file_name, char *path_out, size_t out_len) {
  FILE *fp;
  const char *name;
  ++xpw_model_counter;
  name = (file_name != NULL && *file_name != '\0') ? file_name : "model.ode";
  snprintf(path_out, out_len, "/tmp/xpw_model_%d_%s", xpw_model_counter, name);
  fp = fopen(path_out, "w");
  if (fp == NULL) {
    return 0;
  }
  if (ode_text != NULL && *ode_text != '\0') {
    fputs(ode_text, fp);
  }
  fclose(fp);
  return 1;
}

static const char *xpw_json_error_with_diag(const char *code, const char *message) {
  XpwStringBuilder sb;
  if (!xpw_sb_init(&sb, 512)) {
    return xpw_set_json("{\"error\":\"allocation_failed\"}");
  }
  xpw_sb_append_raw(&sb, "{\"diagnostics\":[{\"code\":");
  xpw_sb_append_json_string(&sb, code);
  xpw_sb_append_raw(&sb, ",\"message\":");
  xpw_sb_append_json_string(&sb, message);
  xpw_sb_append_raw(&sb, ",\"tier\":\"warning\"}]}");
  xpw_set_json(sb.data);
  xpw_sb_free(&sb);
  return xpw_last_json;
}

int xpw_boot(void) {
  mkdir("/tmp", 0777);
  if (getenv("HOME") == NULL) {
    setenv("HOME", "/tmp", 1);
  }
  xpw_model_ready = 0;
  return 0;
}

const char *xpw_load_model(const char *ode_text, const char *file_name) {
  char model_path[512];
  char arg0[] = "xppaut";
  char arg2[] = "-quiet";
  char arg3[] = "1";
  char *argv[5];

  if (ode_text == NULL || *ode_text == '\0') {
    return xpw_set_json("{\"error\":\"empty_model\"}");
  }

  if (!xpw_write_model_file(ode_text, file_name, model_path, sizeof(model_path))) {
    return xpw_set_json("{\"error\":\"failed_to_write_model\"}");
  }

  xpw_store_loaded_copy(ode_text, file_name);

  argv[0] = arg0;
  argv[1] = model_path;
  argv[2] = arg2;
  argv[3] = arg3;
  argv[4] = NULL;

  got_file = 1;
  strncpy(this_file, model_path, sizeof(this_file) - 1);
  this_file[sizeof(this_file) - 1] = '\0';

  do_main(4, argv);

  tfBell = 0;
  xpw_model_ready = 1;

  return xpw_set_json("{\"status\":\"ok\"}");
}

const char *xpw_get_model_info(void) {
  XpwStringBuilder sb;
  int i;
  int first;
  double v;

  if (!xpw_model_ready) {
    return xpw_set_json("{\"variables\":[],\"parameters\":[],\"parameterValues\":{},\"auxiliaries\":[],\"sets\":[],\"diagnostics\":[{\"code\":\"MODEL_NOT_LOADED\",\"message\":\"Load a model before requesting model info\",\"tier\":\"warning\"}]}");
  }

  if (!xpw_sb_init(&sb, 4096)) {
    return xpw_set_json("{\"variables\":[],\"parameters\":[],\"parameterValues\":{},\"auxiliaries\":[],\"sets\":[],\"diagnostics\":[{\"code\":\"ALLOCATION_FAILED\",\"message\":\"Out of memory\",\"tier\":\"warning\"}]}");
  }

  xpw_sb_append_raw(&sb, "{\"variables\":[");
  first = 1;
  for (i = 0; i < NODE + NMarkov && i < MAXODE; ++i) {
    if (!first) {
      xpw_sb_append_raw(&sb, ",");
    }
    xpw_sb_append_json_string(&sb, uvar_names[i]);
    first = 0;
  }

  xpw_sb_append_raw(&sb, "],\"parameters\":[");
  first = 1;
  for (i = 0; i < NUPAR && i < MAXPAR; ++i) {
    if (!first) {
      xpw_sb_append_raw(&sb, ",");
    }
    xpw_sb_append_json_string(&sb, upar_names[i]);
    first = 0;
  }

  xpw_sb_append_raw(&sb, "],\"parameterValues\":{");
  first = 1;
  for (i = 0; i < NUPAR && i < MAXPAR; ++i) {
    if (get_val(upar_names[i], &v) == 0) {
      continue;
    }
    if (!xpw_is_finite(v)) {
      continue;
    }
    if (!first) {
      xpw_sb_append_raw(&sb, ",");
    }
    xpw_sb_append_json_string(&sb, upar_names[i]);
    xpw_sb_appendf(&sb, ":%.17g", v);
    first = 0;
  }

  xpw_sb_append_raw(&sb, "},\"auxiliaries\":[");
  first = 1;
  for (i = 0; i < Naux && i < MAXODE; ++i) {
    if (!first) {
      xpw_sb_append_raw(&sb, ",");
    }
    xpw_sb_append_json_string(&sb, aux_names[i]);
    first = 0;
  }

  xpw_sb_append_raw(&sb, "],\"sets\":[],\"diagnostics\":[]}");

  xpw_set_json(sb.data);
  xpw_sb_free(&sb);
  return xpw_last_json;
}

const char *xpw_run_simulation(const char *request_json) {
  XpwStringBuilder sb;
  XpwKvPair requested_ic[XPW_MAX_PAIRS];
  int requested_ic_count;
  int i;
  int j;
  int valid_count;
  int *valid_rows;
  int first;
  char integrator[64];
  int output_stride;
  double t0;
  double tend;
  double dt;
  double transient;

  if (!xpw_model_ready) {
    return xpw_set_json("{\"time\":[],\"series\":{},\"diagnostics\":[{\"code\":\"MODEL_NOT_LOADED\",\"message\":\"Load a model before running simulation\",\"tier\":\"warning\"}]}");
  }

  strncpy(integrator, "rk4", sizeof(integrator) - 1);
  integrator[sizeof(integrator) - 1] = '\0';
  (void)xpw_parse_string(request_json, "integrator", integrator, sizeof(integrator));

  t0 = T0;
  tend = TEND;
  dt = DELTA_T;
  transient = TRANS;
  output_stride = NJMP > 0 ? NJMP : 1;

  (void)xpw_parse_double(request_json, "t0", &t0);
  (void)xpw_parse_double(request_json, "tEnd", &tend);
  (void)xpw_parse_double(request_json, "dt", &dt);
  (void)xpw_parse_double(request_json, "transient", &transient);
  (void)xpw_parse_int(request_json, "outputStride", &output_stride);
  if (output_stride < 1) {
    output_stride = 1;
  }

  METHOD = xpw_method_from_name(integrator);
  T0 = t0;
  TEND = tend;
  DELTA_T = dt;
  TRANS = transient;
  NJMP = output_stride;

  xpw_apply_parameter_overrides(request_json);
  xpw_apply_initial_conditions(request_json);

  run_now();

  if (storind <= 0 || storage == NULL) {
    return xpw_set_json("{\"time\":[],\"series\":{},\"diagnostics\":[{\"code\":\"EMPTY_SIMULATION\",\"message\":\"Simulation returned no stored points\",\"tier\":\"warning\"}]}");
  }

  valid_rows = (int *)malloc((size_t)storind * sizeof(int));
  if (valid_rows == NULL) {
    return xpw_set_json("{\"time\":[],\"series\":{},\"diagnostics\":[{\"code\":\"ALLOCATION_FAILED\",\"message\":\"Out of memory while serializing simulation\",\"tier\":\"warning\"}]}");
  }

  valid_count = 0;
  for (i = 0; i < storind; ++i) {
    int ok;
    ok = xpw_is_finite((double)storage[0][i]);
    if (ok) {
      for (j = 0; j < NEQ && j < MAXODE; ++j) {
        if (!xpw_is_finite((double)storage[j + 1][i])) {
          ok = 0;
          break;
        }
      }
    }
    if (ok) {
      valid_rows[valid_count++] = i;
    }
  }

  if (!xpw_sb_init(&sb, (size_t)(4096 + valid_count * 128))) {
    free(valid_rows);
    return xpw_set_json("{\"time\":[],\"series\":{},\"diagnostics\":[{\"code\":\"ALLOCATION_FAILED\",\"message\":\"Out of memory\",\"tier\":\"warning\"}]}");
  }

  xpw_sb_append_raw(&sb, "{\"time\":[");
  for (i = 0; i < valid_count; ++i) {
    if (i > 0) {
      xpw_sb_append_raw(&sb, ",");
    }
    xpw_sb_appendf(&sb, "%.9g", (double)storage[0][valid_rows[i]]);
  }

  xpw_sb_append_raw(&sb, "],\"series\":{");
  first = 1;
  for (j = 0; j < NEQ && j < MAXODE; ++j) {
    if (!first) {
      xpw_sb_append_raw(&sb, ",");
    }
    xpw_sb_append_json_string(&sb, uvar_names[j]);
    xpw_sb_append_raw(&sb, ":[");
    for (i = 0; i < valid_count; ++i) {
      if (i > 0) {
        xpw_sb_append_raw(&sb, ",");
      }
      xpw_sb_appendf(&sb, "%.9g", (double)storage[j + 1][valid_rows[i]]);
    }
    xpw_sb_append_raw(&sb, "]");
    first = 0;
  }
  xpw_sb_append_raw(&sb, "},\"diagnostics\":[");
  if (valid_count == 0) {
    xpw_sb_append_raw(&sb, "{\"code\":\"NO_FINITE_POINTS\",\"message\":\"Simulation produced no finite points\",\"tier\":\"warning\"}");
  }
  xpw_sb_append_raw(&sb, "]}");

  free(valid_rows);
  xpw_set_json(sb.data);
  xpw_sb_free(&sb);
  (void)requested_ic;
  (void)requested_ic_count;
  return xpw_last_json;
}

static void xpw_copy_current_state(double *dst) {
  int i;
  for (i = 0; i < NODE && i < MAXODE; ++i) {
    dst[i] = last_ic[i];
  }
}

static void xpw_relax_to_steady_state(void) {
  double state[MAXODE];
  double k1[MAXODE];
  double k2[MAXODE];
  double k3[MAXODE];
  double k4[MAXODE];
  double temp[MAXODE];
  double dt;
  double t;
  int i;
  int j;
  int max_steps;

  if (NODE <= 0 || NODE > MAXODE) {
    return;
  }

  dt = DELTA_T;
  if (!xpw_is_finite(dt) || dt <= 0.0) {
    dt = 0.05;
  }
  if (dt > 0.25) {
    dt = 0.25;
  }
  max_steps = 40000;

  xpw_copy_current_state(state);
  t = 0.0;
  for (i = 0; i < max_steps; ++i) {
    double max_rhs;
    my_rhs(t, state, k1, NODE);
    max_rhs = 0.0;
    for (j = 0; j < NODE; ++j) {
      double a;
      a = fabs(k1[j]);
      if (a > max_rhs) {
        max_rhs = a;
      }
      temp[j] = state[j] + 0.5 * dt * k1[j];
    }
    if (max_rhs < 1e-8) {
      break;
    }

    my_rhs(t + 0.5 * dt, temp, k2, NODE);
    for (j = 0; j < NODE; ++j) {
      temp[j] = state[j] + 0.5 * dt * k2[j];
    }
    my_rhs(t + 0.5 * dt, temp, k3, NODE);
    for (j = 0; j < NODE; ++j) {
      temp[j] = state[j] + dt * k3[j];
    }
    my_rhs(t + dt, temp, k4, NODE);
    for (j = 0; j < NODE; ++j) {
      state[j] += (dt / 6.0) * (k1[j] + 2.0 * k2[j] + 2.0 * k3[j] + k4[j]);
    }
    t += dt;
  }

  for (j = 0; j < NODE; ++j) {
    if (xpw_is_finite(state[j])) {
      last_ic[j] = state[j];
      set_val(uvar_names[j], state[j]);
    }
  }
}

const char *xpw_run_phase_plane(const char *request_json) {
  XpwStringBuilder sb;
  char x_name[XPW_MAX_NAME];
  char y_name[XPW_MAX_NAME];
  int ix;
  int iy;
  int x_steps;
  int y_steps;
  int i;
  int j;
  int point_count;
  double x_min;
  double x_max;
  double y_min;
  double y_max;
  double x_val;
  double y_val;
  double dx;
  double dy;
  double state[MAXODE];
  double rhs_vec[MAXODE];
  int traj_enabled;
  double traj_t_end;
  double traj_dt;
  int traj_steps;
  double t;
  double k1[MAXODE];
  double k2[MAXODE];
  double k3[MAXODE];
  double k4[MAXODE];
  double temp[MAXODE];

  if (!xpw_model_ready) {
    return xpw_set_json("{\"vectorField\":[],\"nullclines\":{\"xNullcline\":[],\"yNullcline\":[]},\"diagnostics\":[{\"code\":\"MODEL_NOT_LOADED\",\"message\":\"Load a model before running phase plane\",\"tier\":\"warning\"}]}");
  }

  x_name[0] = '\0';
  y_name[0] = '\0';
  (void)xpw_parse_string(request_json, "xVar", x_name, sizeof(x_name));
  (void)xpw_parse_string(request_json, "yVar", y_name, sizeof(y_name));

  ix = xpw_find_state_index(x_name);
  iy = xpw_find_state_index(y_name);
  if (ix < 0 || iy < 0 || ix >= NODE || iy >= NODE) {
    return xpw_set_json("{\"vectorField\":[],\"nullclines\":{\"xNullcline\":[],\"yNullcline\":[]},\"diagnostics\":[{\"code\":\"VARIABLE_NOT_FOUND\",\"message\":\"Phase-plane variables were not found among ODE state variables\",\"tier\":\"warning\"}]}");
  }

  xpw_apply_parameter_overrides(request_json);

  x_min = -2.0;
  x_max = 2.0;
  y_min = -2.0;
  y_max = 2.0;
  x_steps = 25;
  y_steps = 25;

  (void)xpw_parse_double(request_json, "xMin", &x_min);
  (void)xpw_parse_double(request_json, "xMax", &x_max);
  (void)xpw_parse_double(request_json, "yMin", &y_min);
  (void)xpw_parse_double(request_json, "yMax", &y_max);
  (void)xpw_parse_int(request_json, "xSteps", &x_steps);
  (void)xpw_parse_int(request_json, "ySteps", &y_steps);

  if (x_steps < 2) {
    x_steps = 2;
  }
  if (y_steps < 2) {
    y_steps = 2;
  }

  xpw_copy_current_state(state);
  xpw_apply_fixed_state(request_json, state);

  point_count = x_steps * y_steps;
  if (!xpw_sb_init(&sb, (size_t)(4096 + point_count * 64))) {
    return xpw_set_json("{\"vectorField\":[],\"nullclines\":{\"xNullcline\":[],\"yNullcline\":[]},\"diagnostics\":[{\"code\":\"ALLOCATION_FAILED\",\"message\":\"Out of memory\",\"tier\":\"warning\"}]}");
  }

  xpw_sb_append_raw(&sb, "{\"vectorField\":[");
  point_count = 0;
  for (j = 0; j < y_steps; ++j) {
    for (i = 0; i < x_steps; ++i) {
      double denom_x;
      double denom_y;
      denom_x = (double)(x_steps - 1);
      denom_y = (double)(y_steps - 1);
      x_val = x_min + (x_max - x_min) * ((double)i / denom_x);
      y_val = y_min + (y_max - y_min) * ((double)j / denom_y);

      state[ix] = x_val;
      state[iy] = y_val;
      my_rhs(0.0, state, rhs_vec, NODE);

      dx = rhs_vec[ix];
      dy = rhs_vec[iy];
      if (!xpw_is_finite(dx) || !xpw_is_finite(dy)) {
        dx = 0.0;
        dy = 0.0;
      }

      if (point_count > 0) {
        xpw_sb_append_raw(&sb, ",");
      }
      xpw_sb_appendf(&sb, "{\"x\":%.9g,\"y\":%.9g,\"dx\":%.9g,\"dy\":%.9g}", x_val, y_val, dx, dy);
      ++point_count;
    }
  }

  xpw_sb_append_raw(&sb, "],\"nullclines\":{\"xNullcline\":[],\"yNullcline\":[]}");

  traj_enabled = 1;
  traj_t_end = 100.0;
  traj_dt = 0.05;
  (void)xpw_parse_bool(request_json, "enabled", &traj_enabled);
  (void)xpw_parse_double(request_json, "tEnd", &traj_t_end);
  (void)xpw_parse_double(request_json, "dt", &traj_dt);

  if (traj_enabled && traj_dt > 0.0 && traj_t_end > 0.0) {
    xpw_sb_append_raw(&sb, ",\"trajectory\":{\"time\":[");

    xpw_copy_current_state(state);
    xpw_apply_fixed_state(request_json, state);

    traj_steps = (int)(traj_t_end / traj_dt) + 1;
    if (traj_steps < 2) {
      traj_steps = 2;
    }
    if (traj_steps > 50000) {
      traj_steps = 50000;
    }

    for (i = 0; i < traj_steps; ++i) {
      t = (double)i * traj_dt;
      if (i > 0) {
        xpw_sb_append_raw(&sb, ",");
      }
      xpw_sb_appendf(&sb, "%.9g", t);

      my_rhs(t, state, k1, NODE);
      for (j = 0; j < NODE; ++j) {
        temp[j] = state[j] + 0.5 * traj_dt * k1[j];
      }
      my_rhs(t + 0.5 * traj_dt, temp, k2, NODE);
      for (j = 0; j < NODE; ++j) {
        temp[j] = state[j] + 0.5 * traj_dt * k2[j];
      }
      my_rhs(t + 0.5 * traj_dt, temp, k3, NODE);
      for (j = 0; j < NODE; ++j) {
        temp[j] = state[j] + traj_dt * k3[j];
      }
      my_rhs(t + traj_dt, temp, k4, NODE);
      for (j = 0; j < NODE; ++j) {
        state[j] += (traj_dt / 6.0) * (k1[j] + 2.0 * k2[j] + 2.0 * k3[j] + k4[j]);
      }
    }

    xpw_sb_append_raw(&sb, "],\"x\":[");

    xpw_copy_current_state(state);
    xpw_apply_fixed_state(request_json, state);
    for (i = 0; i < traj_steps; ++i) {
      t = (double)i * traj_dt;
      if (i > 0) {
        xpw_sb_append_raw(&sb, ",");
      }
      xpw_sb_appendf(&sb, "%.9g", state[ix]);

      my_rhs(t, state, k1, NODE);
      for (j = 0; j < NODE; ++j) {
        temp[j] = state[j] + 0.5 * traj_dt * k1[j];
      }
      my_rhs(t + 0.5 * traj_dt, temp, k2, NODE);
      for (j = 0; j < NODE; ++j) {
        temp[j] = state[j] + 0.5 * traj_dt * k2[j];
      }
      my_rhs(t + 0.5 * traj_dt, temp, k3, NODE);
      for (j = 0; j < NODE; ++j) {
        temp[j] = state[j] + traj_dt * k3[j];
      }
      my_rhs(t + traj_dt, temp, k4, NODE);
      for (j = 0; j < NODE; ++j) {
        state[j] += (traj_dt / 6.0) * (k1[j] + 2.0 * k2[j] + 2.0 * k3[j] + k4[j]);
      }
    }

    xpw_sb_append_raw(&sb, "],\"y\":[");

    xpw_copy_current_state(state);
    xpw_apply_fixed_state(request_json, state);
    for (i = 0; i < traj_steps; ++i) {
      t = (double)i * traj_dt;
      if (i > 0) {
        xpw_sb_append_raw(&sb, ",");
      }
      xpw_sb_appendf(&sb, "%.9g", state[iy]);

      my_rhs(t, state, k1, NODE);
      for (j = 0; j < NODE; ++j) {
        temp[j] = state[j] + 0.5 * traj_dt * k1[j];
      }
      my_rhs(t + 0.5 * traj_dt, temp, k2, NODE);
      for (j = 0; j < NODE; ++j) {
        temp[j] = state[j] + 0.5 * traj_dt * k2[j];
      }
      my_rhs(t + 0.5 * traj_dt, temp, k3, NODE);
      for (j = 0; j < NODE; ++j) {
        temp[j] = state[j] + traj_dt * k3[j];
      }
      my_rhs(t + traj_dt, temp, k4, NODE);
      for (j = 0; j < NODE; ++j) {
        state[j] += (traj_dt / 6.0) * (k1[j] + 2.0 * k2[j] + 2.0 * k3[j] + k4[j]);
      }
    }

    xpw_sb_append_raw(&sb, "]}");
  }

  xpw_sb_append_raw(&sb, ",\"diagnostics\":[]}");

  xpw_set_json(sb.data);
  xpw_sb_free(&sb);
  return xpw_last_json;
}

static void xpw_apply_auto_controls(const char *json) {
  int iv;
  int requested_points;
  int point_density;
  int effective_nmx;
  double dv;

  requested_points = Auto.npr;
  point_density = 1;

  iv = Auto.ntst;
  if (xpw_parse_int(json, "ntst", &iv) && iv > 1) {
    Auto.ntst = iv;
  }
  iv = Auto.npr;
  if (xpw_parse_int(json, "npr", &iv) && iv > 0) {
    requested_points = iv;
  }
  iv = 1;
  if (xpw_parse_int(json, "pointDensity", &iv) && iv > 0) {
    point_density = iv;
  }
  iv = Auto.nmx;
  if (xpw_parse_int(json, "nmx", &iv) && iv > 1) {
    Auto.nmx = iv;
  }
  effective_nmx = Auto.nmx;
  if (point_density > 1) {
    if (effective_nmx > 500000 / point_density) {
      effective_nmx = 500000;
    } else {
      effective_nmx *= point_density;
    }
    Auto.nmx = effective_nmx;
  }
  if (requested_points < 1) {
    requested_points = 1;
  }
  iv = requested_points * point_density * 4;
  if (iv > 500000) {
    iv = 500000;
  }
  if (Auto.nmx < iv) {
    Auto.nmx = iv;
  }
  /* Emit every continuation step; UI controls density via nmx/pointDensity. */
  Auto.npr = 1;
  iv = Auto.ncol;
  if (xpw_parse_int(json, "ncol", &iv) && iv > 0) {
    Auto.ncol = iv;
  }

  dv = Auto.ds;
  if (xpw_parse_double(json, "ds", &dv) && xpw_is_finite(dv) && dv != 0.0) {
    Auto.ds = dv;
  }
  dv = Auto.dsmin;
  if (xpw_parse_double(json, "dsMin", &dv) && xpw_is_finite(dv) && dv > 0.0) {
    Auto.dsmin = dv;
  }
  dv = Auto.dsmax;
  if (xpw_parse_double(json, "dsMax", &dv) && xpw_is_finite(dv) && dv > 0.0) {
    Auto.dsmax = dv;
  }
  dv = Auto.rl0;
  if (xpw_parse_double(json, "rl0", &dv) && xpw_is_finite(dv)) {
    Auto.rl0 = dv;
  }
  dv = Auto.rl1;
  if (xpw_parse_double(json, "rl1", &dv) && xpw_is_finite(dv)) {
    Auto.rl1 = dv;
  }
  dv = Auto.a0;
  if (xpw_parse_double(json, "a0", &dv) && xpw_is_finite(dv)) {
    Auto.a0 = dv;
  }
  dv = Auto.a1;
  if (xpw_parse_double(json, "a1", &dv) && xpw_is_finite(dv)) {
    Auto.a1 = dv;
  }
  dv = Auto.epsl;
  if (xpw_parse_double(json, "epsl", &dv) && xpw_is_finite(dv) && dv > 0.0) {
    Auto.epsl = dv;
  }
  dv = Auto.epsu;
  if (xpw_parse_double(json, "epsu", &dv) && xpw_is_finite(dv) && dv > 0.0) {
    Auto.epsu = dv;
  }
  dv = Auto.epss;
  if (xpw_parse_double(json, "epss", &dv) && xpw_is_finite(dv) && dv > 0.0) {
    Auto.epss = dv;
  }
}

static void xpw_normalize_auto_windows(const char *primary_name, int y_index) {
  double pval;
  double yval;
  double width;
  double min_width;
  double margin;
  int has_primary;
  int has_y;

  has_primary = 0;
  has_y = 0;
  pval = 0.0;
  yval = 0.0;

  if (primary_name != NULL && primary_name[0] != '\0' && get_val(primary_name, &pval) != 0 && xpw_is_finite(pval)) {
    has_primary = 1;
  }
  if (y_index >= 0 && y_index < NODE && get_val(uvar_names[y_index], &yval) != 0 && xpw_is_finite(yval)) {
    has_y = 1;
  }

  if (!xpw_is_finite(Auto.rl0) || !xpw_is_finite(Auto.rl1) || Auto.rl1 <= Auto.rl0) {
    if (has_primary) {
      width = fmax(0.5, fabs(pval) * 0.4);
      Auto.rl0 = pval - width / 2.0;
      Auto.rl1 = pval + width / 2.0;
    } else {
      Auto.rl0 = 0.0;
      Auto.rl1 = 1.0;
    }
  }

  if (has_primary) {
    width = Auto.rl1 - Auto.rl0;
    min_width = fmax(0.25, fmax(1.0, fabs(pval) * 0.4));
    if (width < min_width) {
      width = min_width;
      Auto.rl0 = pval - width / 2.0;
      Auto.rl1 = pval + width / 2.0;
    } else {
      margin = 0.05 * width;
      if (pval <= Auto.rl0 + margin || pval >= Auto.rl1 - margin) {
        Auto.rl0 = pval - width / 2.0;
        Auto.rl1 = pval + width / 2.0;
      }
    }
  }

  if (!xpw_is_finite(Auto.a0) || !xpw_is_finite(Auto.a1) || Auto.a1 <= Auto.a0) {
    Auto.a0 = -1e6;
    Auto.a1 = 1e6;
  }
  if (has_y) {
    width = Auto.a1 - Auto.a0;
    if (yval < Auto.a0 || yval > Auto.a1 || width < 10.0) {
      width = fmax(200.0, fabs(yval) * 4.0);
      Auto.a0 = yval - width / 2.0;
      Auto.a1 = yval + width / 2.0;
    }
  } else if (Auto.a1 - Auto.a0 < 10.0) {
    Auto.a0 = -1e6;
    Auto.a1 = 1e6;
  }
}

static void xpw_copy_diagram_to_grabpt(DIAGRAM *d) {
  int i;
  if (d == NULL) {
    return;
  }
  grabpt.ibr = d->ibr;
  grabpt.lab = d->lab;
  grabpt.icp1 = d->icp1;
  grabpt.icp2 = d->icp2;
  grabpt.icp3 = d->icp3;
  grabpt.icp4 = d->icp4;
  grabpt.icp5 = d->icp5;
  grabpt.per = d->per;
  grabpt.torper = d->torper;
  grabpt.itp = d->itp;
  grabpt.ntot = d->ntot;
  grabpt.nfpar = d->nfpar;
  grabpt.index = d->index;
  grabpt.flag = 1;
  for (i = 0; i < 20; ++i) {
    grabpt.par[i] = d->par[i];
  }
  for (i = 0; i < NODE && i < NAUTO; ++i) {
    grabpt.uhi[i] = d->uhi[i];
    grabpt.ulo[i] = d->ulo[i];
    grabpt.u0[i] = d->u0[i];
    grabpt.ubar[i] = d->ubar[i];
  }
}

static void xpw_normalize_bif_symbol(const char *sym, char *out, size_t out_size) {
  size_t i;
  size_t j;
  if (out_size == 0) {
    return;
  }
  out[0] = '\0';
  if (sym == NULL) {
    return;
  }
  j = 0;
  for (i = 0; sym[i] != '\0' && j + 1 < out_size; ++i) {
    unsigned char ch;
    ch = (unsigned char)sym[i];
    if (isspace(ch)) {
      continue;
    }
    out[j++] = (char)toupper(ch);
  }
  out[j] = '\0';
}

static int xpw_is_special_bif_symbol(const char *sym) {
  char normalized[16];
  xpw_normalize_bif_symbol(sym, normalized, sizeof(normalized));
  if (normalized[0] == '\0') {
    return 0;
  }
  if (strncmp(normalized, "HB", 2) == 0 || strncmp(normalized, "LP", 2) == 0 || strncmp(normalized, "BP", 2) == 0 ||
      strncmp(normalized, "PD", 2) == 0 || strncmp(normalized, "TR", 2) == 0 || strcmp(normalized, "BT") == 0 ||
      strcmp(normalized, "CP") == 0 || strcmp(normalized, "GH") == 0 || strcmp(normalized, "ZH") == 0 ||
      strcmp(normalized, "NS") == 0 || strncmp(normalized, "BIF", 3) == 0) {
    return 1;
  }
  return 0;
}

static DIAGRAM *xpw_find_diagram_by_label(int label) {
  DIAGRAM *d;
  d = bifd;
  while (d != NULL) {
    if (d->lab == label) {
      return d;
    }
    d = d->next;
  }
  return NULL;
}

static DIAGRAM *xpw_find_seed_diagram(void) {
  DIAGRAM *d;
  char sym[16];
  char normalized[16];
  d = bifd;
  while (d != NULL) {
    if (d->lab > 0) {
      get_bif_sym(sym, d->itp);
      xpw_normalize_bif_symbol(sym, normalized, sizeof(normalized));
      if (strncmp(normalized, "HB", 2) == 0 || strncmp(normalized, "LP", 2) == 0 || strncmp(normalized, "BP", 2) == 0) {
        return d;
      }
    }
    d = d->next;
  }
  return NULL;
}

static void xpw_append_bif_point(XpwStringBuilder *sb, int *first_point, int *out_index, int label,
                                 const char *sym, int branch, int stable, double x, double y,
                                 double secondary_y, double period, int ntot, int itp, const char *primary_name, double primary_value,
                                 const char *secondary_name, int has_secondary, double secondary_value, const double *state_values) {
  int j;
  int first_state;
  if (!(*first_point)) {
    xpw_sb_append_raw(sb, ",");
  }
  xpw_sb_append_raw(sb, "{\"index\":");
  xpw_sb_appendf(sb, "%d", *out_index);
  xpw_sb_append_raw(sb, ",\"label\":");
  xpw_sb_appendf(sb, "%d", label < 0 ? 0 : label);
  xpw_sb_append_raw(sb, ",\"type\":");
  xpw_sb_append_json_string(sb, sym);
  xpw_sb_append_raw(sb, ",\"branch\":");
  xpw_sb_appendf(sb, "%d", branch);
  xpw_sb_append_raw(sb, ",\"stable\":");
  xpw_sb_append_raw(sb, stable ? "true" : "false");
  xpw_sb_append_raw(sb, ",\"x\":");
  xpw_sb_appendf(sb, "%.9g", x);
  xpw_sb_append_raw(sb, ",\"y\":");
  xpw_sb_appendf(sb, "%.9g", y);
  xpw_sb_append_raw(sb, ",\"secondaryY\":");
  xpw_sb_appendf(sb, "%.9g", secondary_y);
  xpw_sb_append_raw(sb, ",\"period\":");
  xpw_sb_appendf(sb, "%.9g", period);
  xpw_sb_append_raw(sb, ",\"ntot\":");
  xpw_sb_appendf(sb, "%d", ntot);
  xpw_sb_append_raw(sb, ",\"itp\":");
  xpw_sb_appendf(sb, "%d", itp);
  xpw_sb_append_raw(sb, ",\"parameters\":{");
  xpw_sb_append_json_string(sb, primary_name);
  xpw_sb_appendf(sb, ":%.9g", primary_value);
  if (has_secondary) {
    xpw_sb_append_raw(sb, ",");
    xpw_sb_append_json_string(sb, secondary_name);
    xpw_sb_appendf(sb, ":%.9g", secondary_value);
  }
  xpw_sb_append_raw(sb, "}");
  if (state_values != NULL) {
    xpw_sb_append_raw(sb, ",\"stateValues\":{");
    first_state = 1;
    for (j = 0; j < NODE; j++) {
      double sv = state_values[j];
      if (!xpw_is_finite(sv)) {
        continue;
      }
      if (!first_state) {
        xpw_sb_append_raw(sb, ",");
      }
      xpw_sb_append_json_string(sb, uvar_names[j]);
      xpw_sb_appendf(sb, ":%.9g", sv);
      first_state = 0;
    }
    xpw_sb_append_raw(sb, "}");
  }
  xpw_sb_append_raw(sb, "}");
  *first_point = 0;
  *out_index = *out_index + 1;
}

const char *xpw_run_bifurcation(const char *request_json) {
  XpwStringBuilder sb;
  char mode[32];
  char start_strategy[32];
  char primary_name[XPW_MAX_NAME];
  char secondary_name[XPW_MAX_NAME];
  char y_name[XPW_MAX_NAME];
  char sym[16];
  int primary_slot;
  int secondary_slot;
  int y_index;
  int continue_label;
  int has_continue_label;
  int is_two_param;
  int out_index;
  int first_point;
  int rendered_npr;
  DIAGRAM *d;
  DIAGRAM *seed;
  char seed_sym[16];

  if (!xpw_model_ready) {
    return xpw_set_json("{\"mode\":\"one_param\",\"points\":[],\"diagnostics\":[{\"code\":\"MODEL_NOT_LOADED\",\"message\":\"Load a model before running bifurcation\",\"tier\":\"warning\"}]}");
  }

  strncpy(mode, "one_param", sizeof(mode) - 1);
  mode[sizeof(mode) - 1] = '\0';
  (void)xpw_parse_string(request_json, "mode", mode, sizeof(mode));
  is_two_param = xpw_ieq(mode, "two_param");
  strncpy(start_strategy, "steady_state", sizeof(start_strategy) - 1);
  start_strategy[sizeof(start_strategy) - 1] = '\0';
  (void)xpw_parse_string(request_json, "startStrategy", start_strategy, sizeof(start_strategy));

  primary_name[0] = '\0';
  secondary_name[0] = '\0';
  y_name[0] = '\0';
  (void)xpw_parse_string(request_json, "primaryParameter", primary_name, sizeof(primary_name));
  (void)xpw_parse_string(request_json, "secondaryParameter", secondary_name, sizeof(secondary_name));
  (void)xpw_parse_string(request_json, "yVariable", y_name, sizeof(y_name));

  primary_slot = xpw_find_auto_slot_for_param(primary_name);
  if (primary_slot < 0) {
    return xpw_set_json("{\"mode\":\"one_param\",\"points\":[],\"diagnostics\":[{\"code\":\"PRIMARY_PARAMETER_NOT_FOUND\",\"message\":\"Primary parameter was not found in AUTO-continuation parameter slots\",\"tier\":\"warning\"}]}");
  }

  secondary_slot = -1;
  if (secondary_name[0] != '\0') {
    secondary_slot = xpw_find_auto_slot_for_param(secondary_name);
  }

  y_index = 0;
  if (y_name[0] != '\0') {
    int tmp;
    tmp = xpw_find_state_index(y_name);
    if (tmp >= 0 && tmp < NODE) {
      y_index = tmp;
    }
  }

  xpw_apply_parameter_overrides(request_json);
  xpw_apply_initial_conditions(request_json);

  yes_reset_auto();
  tfBell = 0;

  Auto.icp1 = primary_slot;
  if (secondary_slot >= 0) {
    Auto.icp2 = secondary_slot;
  }
  Auto.var = y_index;
  xpw_apply_auto_controls(request_json);
  xpw_normalize_auto_windows(primary_name, y_index);
  if (!is_two_param && xpw_ieq(start_strategy, "steady_state")) {
    xpw_relax_to_steady_state();
  }

  auto_new_ss();

  has_continue_label = xpw_parse_int(request_json, "continueLabel", &continue_label);
  if (is_two_param) {
    seed = NULL;
    if (secondary_slot < 0) {
      return xpw_set_json("{\"mode\":\"two_param\",\"points\":[],\"diagnostics\":[{\"code\":\"SECONDARY_PARAMETER_NOT_FOUND\",\"message\":\"Secondary parameter is required for two-parameter continuation\",\"tier\":\"warning\"}]}");
    }

    if (has_continue_label) {
      seed = xpw_find_diagram_by_label(continue_label);
    }
    if (seed == NULL) {
      seed = xpw_find_seed_diagram();
    }
    if (seed == NULL) {
      return xpw_set_json("{\"mode\":\"two_param\",\"points\":[],\"diagnostics\":[{\"code\":\"SEED_POINT_NOT_FOUND\",\"message\":\"No labeled seed point was found for two-parameter continuation\",\"tier\":\"warning\"}]}");
    }

    xpw_copy_diagram_to_grabpt(seed);
    Auto.icp1 = primary_slot;
    Auto.icp2 = secondary_slot;

    get_bif_sym(sym, seed->itp);
    xpw_normalize_bif_symbol(sym, seed_sym, sizeof(seed_sym));
    if (strncmp(seed_sym, "LP", 2) == 0) {
      auto_2p_limit(1);
    } else if (strncmp(seed_sym, "BP", 2) == 0) {
      auto_2p_branch(1);
    } else {
      auto_2p_hopf();
    }
  }

  if (!xpw_sb_init(&sb, 16384)) {
    return xpw_set_json("{\"mode\":\"one_param\",\"points\":[],\"diagnostics\":[{\"code\":\"ALLOCATION_FAILED\",\"message\":\"Out of memory\",\"tier\":\"warning\"}]}");
  }

  xpw_sb_append_raw(&sb, "{\"mode\":");
  xpw_sb_append_json_string(&sb, is_two_param ? "two_param" : "one_param");
  xpw_sb_append_raw(&sb, ",\"points\":[");

  out_index = 0;
  first_point = 1;
  d = bifd;
  rendered_npr = Auto.npr;
  while (d != NULL) {
    double x;
    double y;
    double y2;
    double sy;
    double par1;
    double par2;
    double secondary_value;
    int include;
    int has_secondary;
    int emit_second;

    include = 1;
    if (d->icp1 != primary_slot) {
      include = 0;
    }
    if (is_two_param) {
      if (d->flag2 == 0) {
        include = 0;
      }
      if (secondary_slot >= 0 && d->icp2 != secondary_slot) {
        include = 0;
      }
    } else {
      if (d->flag2 != 0) {
        include = 0;
      }
    }

    if (!include) {
      d = d->next;
      continue;
    }

    par1 = d->par[d->icp1];
    par2 = 0.0;
    if (d->icp2 >= 0 && d->icp2 < 20) {
      par2 = d->par[d->icp2];
    }
    auto_xy_plot(&x, &y, &y2, par1, par2, d->per, d->uhi, d->ulo, d->ubar, d->norm);

    if (is_two_param) {
      y = par2;
      y2 = y;
      sy = y;
    } else {
      sy = y2;
      if (!xpw_is_finite(y) && y_index >= 0 && y_index < NODE) {
        y = d->u0[y_index];
      }
      if (!xpw_is_finite(y2) && y_index >= 0 && y_index < NODE) {
        y2 = d->ulo[y_index];
        sy = y2;
      }
    }

    if (!xpw_is_finite(x) || !xpw_is_finite(y)) {
      d = d->next;
      continue;
    }

    get_bif_sym(sym, d->itp);
    if (sym[0] == '\0') {
      strcpy(sym, "PT");
    }

    has_secondary = secondary_slot >= 0 && d->icp2 >= 0 && d->icp2 < 20;
    secondary_value = has_secondary ? d->par[d->icp2] : 0.0;
    xpw_append_bif_point(&sb, &first_point, &out_index, xpw_is_special_bif_symbol(sym) ? d->lab : 0, sym, d->ibr, d->ntot < 0, x, y, sy, d->per, d->ntot, d->itp,
                         primary_name, d->par[d->icp1], secondary_name, has_secondary, secondary_value, d->u0);

    emit_second = 0;
    if (!is_two_param && xpw_is_finite(y2) && fabs(y2 - y) > 1e-8) {
      emit_second = 1;
    }
    if (emit_second) {
      xpw_append_bif_point(&sb, &first_point, &out_index, 0, sym, d->ibr, d->ntot < 0, x, y2, y, d->per, d->ntot, d->itp,
                           primary_name, d->par[d->icp1], secondary_name, has_secondary, secondary_value, d->ulo);
    }
    d = d->next;
  }

  xpw_sb_append_raw(&sb, "],\"diagnostics\":[");
  if (out_index == 0) {
    xpw_sb_append_raw(&sb, "{\"code\":\"NO_FINITE_BIFURCATION_POINTS\",\"message\":\"Bifurcation output did not contain finite points to render\",\"tier\":\"warning\"}");
  } else if (out_index < 10) {
    xpw_sb_appendf(&sb,
                   "{\"code\":\"SPARSE_BIFURCATION_OUTPUT\",\"message\":\"Bifurcation produced only %d plotted points (AUTO nmx=%d, npr_interval=%d); increase point density or nmx for denser branches\",\"tier\":\"warning\"}",
                   out_index, Auto.nmx, rendered_npr);
  }
  xpw_sb_append_raw(&sb, "]}");

  xpw_set_json(sb.data);
  xpw_sb_free(&sb);
  return xpw_last_json;
}

void xpw_free(void) {
  if (xpw_last_json != NULL) {
    free(xpw_last_json);
    xpw_last_json = NULL;
  }
  if (xpw_loaded_ode != NULL) {
    free(xpw_loaded_ode);
    xpw_loaded_ode = NULL;
  }
  if (xpw_loaded_name != NULL) {
    free(xpw_loaded_name);
    xpw_loaded_name = NULL;
  }
  xpw_model_ready = 0;
}
