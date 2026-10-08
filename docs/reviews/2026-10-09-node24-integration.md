# Node 24 및 Flowise–Worker 통합 기록 — 2026-10-09

원본 `9291856d1ea4a4ceea9f8fef8ce14f4f6c81e8eb`를 병합 이력으로 보존하면서
본 수정본의 동작을 유지한다. Node 24.21.0 / pnpm 10.26.0 / Flowise 3.1.4를
기준으로 Web과 Worker가 같은 공통 소스와 lockfile을 사용한다.

## 보존 및 변경 결정

- Vora 모델·하위 flow 도구·override, 커스텀 임베드의 기존 Git 커밋을 보존했다.
- direct tool return, progress, relay 채널, 개별 중단, 큐 완료 복구를 유지했다.
- SQL의 CTE 쓰기 차단, SSO identity binding, lazy import를 유지했다.
- 원본 Cloud 서비스 종료용 가입·초대 제한과 종료 배너는 반영하지 않았다.
- 공개 임베드 중단 계약과 큐 관리자 Basic Auth를 보존하고 관리자 rate limit을 추가했다.
- AWS SDK/S3 타입, TypeORM, MCP, multer 등은 의존 소스와 lockfile을 함께 반영했다.
- protobufjs 7.x, Elasticsearch transport 8.x 범위를 유지했다. xlsx 0.20.3 및
  기존 Groq override도 보존했다.
- `@tootallnate/once`는 보안 수정이 있는 CommonJS 2.0.1로 고정했다. 원본의
  3.x 일괄 override는 실제 서버 테스트 4개 suite에서 ESM 로드 실패를 유발했다.
- Canvas 3.2.0 및 Debian 기반 이미지를 사용한다. Alpine에서 확인된 ONNX
  native load abort와 설치 스크립트 미실행 Canvas 문제를 함께 해결한다.
- Sharp 0.32.6/0.33.5 동시 로드 시 재현한 native abort를 해결하기 위해 0.33.5로
  통일하고 Transformers의 이미지 변환 API도 함께 검증한다.
- 각 Docker 빌드에 네이티브 실행 검사를 포함해 설치 성공과 실제 로드를 구별한다.
- `docker/Dockerfile`도 npm 원본 배포본 대신 현재 수정본 소스를 빌드한다.
- Worker의 완료 로그는 공통 BaseQueue에 보존했다. 두 저장소는 root Dockerfile의
  시작 명령(Web/Worker)을 제외한 공통 코드를 일치시킨다.
- lint에서 발견한 기존 포맷 오류와 임베드 래퍼의 누락된 propTypes를 수정했다.
  관련 Vora 코드 수정은 포맷에 한정된다.

## 검증 결과

최종 이미지 검증 후 결과를 아래에 기록한다.

## 이후 업데이트의 완료 조건

1. 양쪽 저장소의 최신 main과 깨끗한 통합 브랜치에서 시작한다.
2. 원본 변경을 Flowise에 병합한다. `.upstream-sync.json`의 예외 목록을 검토하며
   충돌 없는 변경도 확인한다. 원본 종료 정책을 제품 정책으로 자동 채택하지 않는다.
3. Node/pnpm/manifest/lockfile을 함께 맞추고 Docker 고정 설치·전체 빌드·전체 테스트·lint를 실행한다.
4. 검증한 Flowise 커밋을 Worker에 merge한다. 공통 코드 충돌은 검증된 Flowise를
   기준으로 해결하고 Worker의 root `CMD ["pnpm", "run", "start-worker"]`를 유지한다.
5. 아래 명령이 성공해야 두 저장소 업데이트가 완료된 것으로 본다.
   ```bash
   node scripts/check-worker-sync.mjs /path/to/Flowise /path/to/Flowise-Worker
   ```
6. Worker 이미지 빌드와 실제 Web→Redis→Worker→Web 작업을 확인한 뒤 각각 commit/push한다.
   강제 push를 하지 않고 원본 및 양쪽 저장소의 병합 이력을 유지한다.
7. 운영자가 Render에서 Worker → Web 순서로 수동 배포한다. Web `/api/v1/ping`,
   Worker Redis 연결·작업 완료 로그와 실제 Vora 요청·스트리밍·중단을 확인한다.

동기화 검사 스크립트는 공통 파일 누락과 의존성 차이를 실패로 처리한다.
GitHub 간 자동 push나 Render 자동 배포는 새로 설정하지 않았다.

## 배포 범위 및 한계

검증에는 격리한 로컬 PostgreSQL 16/Redis 7과 Linux amd64 컨테이너를 사용한다.
운영 DB·외부 LLM/API 자격증명은 사용하지 않는다. Node 호환성·빌드·회귀 테스트·큐
왕복은 배포 전 검증이며 실제 Render 리소스 제한, Dashboard 설정, 외부 모델 결과는
운영자의 수동 배포 및 로그로 최종 확인한다. 기존 legacy 패키지의 peer/deprecation
경고는 완전히 제거하지 않았으며, 경고 억제로 설치를 통과시키지 않았다.
