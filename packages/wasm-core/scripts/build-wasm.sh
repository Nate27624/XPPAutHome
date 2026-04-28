#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
OUT_DIR="${ROOT_DIR}/packages/wasm-core/dist/wasm"
SRC_DIR="${ROOT_DIR}/packages/wasm-core/src/wasm"
VENDOR_DIR="${ROOT_DIR}/vendor/xppaut"

mkdir -p "${OUT_DIR}"

if ! command -v emcc >/dev/null 2>&1; then
  EMSDK_ENV="${EMSDK:-$HOME/emsdk}/emsdk_env.sh"
  if [[ -f "${EMSDK_ENV}" ]]; then
    # Allow local builds even when the caller shell did not source emsdk yet.
    EMSDK_QUIET=1 source "${EMSDK_ENV}" >/dev/null 2>&1 || true
  fi
fi

if ! command -v emcc >/dev/null 2>&1; then
  echo "emcc is not installed. Install Emscripten to build the native XPPAUT WASM core." >&2
  echo "If emsdk is installed, run: source \"$HOME/emsdk/emsdk_env.sh\"" >&2
  exit 1
fi

if [[ ! -f "${VENDOR_DIR}/Makefile" ]]; then
  echo "Missing vendor XPPAUT source at ${VENDOR_DIR}" >&2
  exit 1
fi

SOURCE_LINE="$(
  cd "${VENDOR_DIR}"
  set +o pipefail
  make -pn | awk -F'= ' '/^SOURCES = /{print $2; exit}'
)"
if [[ -z "${SOURCE_LINE}" ]]; then
  echo "Could not extract SOURCES from ${VENDOR_DIR}/Makefile" >&2
  exit 1
fi

read -r -a SOURCE_FILES <<<"${SOURCE_LINE}"

EMCC_SOURCES=()
for src in "${SOURCE_FILES[@]}"; do
  case "${src}" in
    sbml2xpp.c)
      # Standalone converter binary, not part of XPPAUT runtime.
      continue
      ;;
  esac
  EMCC_SOURCES+=("${VENDOR_DIR}/${src}")
done

EMCC_SOURCES+=(
  "${SRC_DIR}/xpw_api.c"
  "${SRC_DIR}/xpp_headless_stubs.c"
)

EMCC_FLAGS=(
  -O2
  -std=gnu89
  -fno-common
  -I"${VENDOR_DIR}"
  -I/opt/X11/include
  -D_XOPEN_SOURCE=600
  -DNOERRNO
  -DNON_UNIX_STDIO
  -DAUTO
  -DCVODE_YES
  -DHAVEDLL
  -DSTRUPR
  -DMYSTR1=8.0
  -DMYSTR2=1
  -DXPP_WASM_HEADLESS=1
  -Wno-implicit-function-declaration
  -Wno-deprecated-non-prototype
  -Wno-strict-prototypes
  -Wno-incompatible-library-redeclaration
  -Wno-format
  -Wno-format-security
  -Wno-int-conversion
  -Wno-incompatible-pointer-types
  -Wno-return-type
  -Wno-parentheses-equality
  -Wno-empty-body
  -Wno-tautological-compare
  -Wno-unused-but-set-variable
  -Wno-unused-variable
  -sMODULARIZE=1
  -sEXPORT_ES6=1
  -sENVIRONMENT=web,worker
  -sALLOW_MEMORY_GROWTH=1
  -sINITIAL_MEMORY=134217728
  -sSTACK_SIZE=5242880
  -sINVOKE_RUN=0
  -sERROR_ON_UNDEFINED_SYMBOLS=0
  -sWARN_ON_UNDEFINED_SYMBOLS=0
  --no-entry
  -sEXPORTED_FUNCTIONS='["_xpw_boot","_xpw_load_model","_xpw_get_model_info","_xpw_run_simulation","_xpw_run_phase_plane","_xpw_run_bifurcation","_xpw_free"]'
  -sEXPORTED_RUNTIME_METHODS='["ccall","cwrap","UTF8ToString"]'
)

echo "Compiling XPPAUT WASM core with ${#EMCC_SOURCES[@]} C translation units..."
emcc "${EMCC_SOURCES[@]}" "${EMCC_FLAGS[@]}" -o "${OUT_DIR}/xppcore.js"

if rg -q "missing function: X" "${OUT_DIR}/xppcore.js"; then
  echo "Build produced unresolved X11 function stubs in ${OUT_DIR}/xppcore.js" >&2
  echo "Add/update headless stubs in packages/wasm-core/src/wasm/xpp_headless_stubs.c" >&2
  exit 1
fi

echo "Built linked XPPAUT wasm core at ${OUT_DIR}/xppcore.js"
