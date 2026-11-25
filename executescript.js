/**
 * 쿠키 값을 가져옵니다.
 */
function getCookie(name) {
  const value = `; ${document.cookie}`;
  const parts = value.split(`; ${name}=`);
  if (parts.length === 2) return parts.pop().split(";").shift();
  return null;
}

/**
 * 두 날짜 사이의 시간 차이를 밀리초 단위로 계산합니다.
 */
function getTimeGap(now, date) {
  if (!date) return -1;
  return new Date(date).getTime() - now.getTime();
}

/**
 * 항목을 남은 시간 순으로 정렬합니다.
 */
function sortByRemainingTime(items) {
  return [...items].sort((a, b) => a.remainingTime_ms - b.remainingTime_ms);
}

/**
 * Canvas API에서 사용자의 즐겨찾기 과목 목록을 가져옵니다.
 */
async function getCourses() {
  return fetchAllPages(
    "https://canvas.skku.edu/api/v1/users/self/favorites/courses?per_page=100",
  );
}

/**
 * Canvas API의 목록을 모든 페이지에 걸쳐 가져옵니다.
 */
async function fetchAllPages(url) {
  const items = [];

  try {
    // Link 헤더의 rel="next"를 따라가며 모든 페이지를 가져옴
    while (url) {
      const response = await fetch(url, {
        method: "GET",
        credentials: "include",
        headers: {
          "Content-Type": "application/json",
        },
        // 요청 시간 제한
        signal: AbortSignal.timeout(5000),
      });

      if (!response.ok) break;

      let text = await response.text();
      text = text.replace(/^while\(1\);/, "");
      const page = JSON.parse(text);
      if (!Array.isArray(page)) break;

      items.push(...page);
      url = getNextPageUrl(response.headers.get("Link"));
    }
    return items;
  } catch (error) {
    // 일부 페이지만 받은 경우에도 받은 만큼은 사용
    return items;
  }
}

/**
 * Canvas API의 Link 헤더에서 다음 페이지 URL을 추출합니다.
 */
function getNextPageUrl(linkHeader) {
  if (!linkHeader) return null;
  const next = linkHeader
    .split(",")
    .find((part) => part.includes('rel="next"'));
  const match = next && next.match(/<([^>]+)>/);
  return match ? match[1] : null;
}

/**
 * 특정 과목의 모듈(강의 및 과제) 정보를 가져옵니다.
 */
async function getCourseModules(courseId, courseName) {
  const authorizationToken = "Bearer " + getCookie("xn_api_token");
  const url = `https://canvas.skku.edu/learningx/api/v1/courses/${courseId}/modules`;
  const now = new Date();
  // assignmentKeys: 모듈에 있는 과제 (완료 여부 무관, "과제 및 평가"와의 중복 제거용)
  const result = { lecture: [], assignment: [], assignmentKeys: new Set() };

  try {
    const response = await fetch(url, {
      method: "GET",
      credentials: "include",
      headers: {
        Authorization: authorizationToken,
      },
      // 요청 시간 제한
      signal: AbortSignal.timeout(5000),
    });

    let text = await response.text();
    text = text.replace(/^while\(1\);/, "");
    const modules = JSON.parse(text);

    // 모듈 처리를 최적화: Promise.all로 병렬 처리
    await Promise.all(
      modules.map(async (module) => {
        if (!module.module_items || !Array.isArray(module.module_items)) {
          return;
        }

        // 항목 처리 최적화: Promise.all 사용하여 병렬 처리
        const itemPromises = module.module_items.map(async (item) => {
          if (item.content_type === "assignment") {
            if (item.content_id) {
              result.assignmentKeys.add(`id:${item.content_id}`);
            }
            if (item.content_data && item.content_data.due_at) {
              result.assignmentKeys.add(
                getAssignmentKey(item.title, item.content_data.due_at),
              );
            }
          }

          // content_data가 없거나 마감기한이 없으면 null 반환
          if (!item.content_data || !item.content_data.due_at) {
            return null;
          }

          const remainingTime = getTimeGap(now, item.content_data.due_at);
          const isUnlocked =
            !item.content_data.unlock_at ||
            getTimeGap(now, item.content_data.unlock_at) < 0;

          // 열람 가능하고 마감기한이 남은 항목만 처리
          if (remainingTime > 0 && isUnlocked) {
            const itemData = {
              course: courseName,
              title: item.title,
              remainingTime_ms: remainingTime,
              due: item.content_data.due_at,
              url: `https://canvas.skku.edu/courses/${courseId}/modules/items/${item.module_item_id}`,
            };

            // 강의 항목
            if (
              item.content_data.use_attendance &&
              item.attendance_status !== "attendance"
            ) {
              return { type: "lecture", data: itemData };
            }
            // 과제 항목
            else if (item.content_type === "assignment" && !item.completed) {
              return { type: "assignment", data: itemData };
            }
          }
          return null;
        });

        // 모든 항목 처리가 완료될 때까지 기다림
        const processedItems = await Promise.all(itemPromises);

        // null이 아닌 항목만 필터링하고 해당 배열에 추가
        processedItems
          .filter((item) => item !== null)
          .forEach((item) => {
            result[item.type].push(item.data);
          });
      }),
    );

    return result;
  } catch (error) {
    return { lecture: [], assignment: [], assignmentKeys: new Set() };
  }
}

/**
 * 모듈 항목과 과제를 같은 과제로 판단하기 위한 키를 만듭니다.
 * 마감 시각은 표기 형식이 다를 수 있으므로 타임스탬프로 정규화합니다.
 */
function getAssignmentKey(title, dueAt) {
  return `${(title || "").trim()}@${new Date(dueAt).getTime()}`;
}

/**
 * 특정 과목의 "과제 및 평가" 탭 과제 중 제출하지 않은 항목을 가져옵니다.
 */
async function getCourseAssignmentList(courseId, courseName) {
  const url =
    `https://canvas.skku.edu/api/v1/courses/${courseId}/assignments` +
    "?include[]=submission&override_assignment_dates=true&per_page=100";
  const now = new Date();
  const assignments = await fetchAllPages(url);

  return assignments
    .filter((assignment) => {
      if (!assignment.due_at || getTimeGap(now, assignment.due_at) <= 0) {
        return false;
      }

      // 아직 열리지 않았거나 이미 닫힌 과제 제외
      if (
        assignment.unlock_at &&
        getTimeGap(now, assignment.unlock_at) > 0
      ) {
        return false;
      }
      if (assignment.lock_at && getTimeGap(now, assignment.lock_at) <= 0) {
        return false;
      }

      // 제출했거나 채점/면제된 과제 제외
      const submission = assignment.submission;
      if (
        submission &&
        (submission.excused || submission.workflow_state !== "unsubmitted")
      ) {
        return false;
      }
      return true;
    })
    .map((assignment) => ({
      key: getAssignmentKey(assignment.name, assignment.due_at),
      id: `id:${assignment.id}`,
      data: {
        course: courseName,
        title: assignment.name,
        remainingTime_ms: getTimeGap(now, assignment.due_at),
        due: assignment.due_at,
        url:
          assignment.html_url ||
          `https://canvas.skku.edu/courses/${courseId}/assignments/${assignment.id}`,
      },
    }));
}

/**
 * 특정 과목의 강의콘텐츠와 "과제 및 평가" 정보를 합칩니다.
 * 두 곳에 모두 있는 과제는 강의콘텐츠(모듈) 쪽 정보를 사용합니다.
 */
async function getCourseToDo(courseId, courseName) {
  const [modules, assignments] = await Promise.all([
    getCourseModules(courseId, courseName),
    getCourseAssignmentList(courseId, courseName),
  ]);

  const extraAssignments = assignments
    .filter(
      ({ key, id }) =>
        !modules.assignmentKeys.has(key) && !modules.assignmentKeys.has(id),
    )
    .map(({ data }) => data);

  return {
    lecture: modules.lecture,
    assignment: [...modules.assignment, ...extraAssignments],
  };
}

/**
 * 모든 과목의 과제 및 강의 정보를 병렬로 가져옵니다.
 */
async function getAllCourseAssignments() {
  try {
    // 1. 모든 과목 정보 가져오기
    const courses = await getCourses();

    if (!courses || courses.length === 0) {
      return { lecture: [], assignment: [] };
    }

    // 2. 각 과목별로 강의콘텐츠와 과제 및 평가 정보를 병렬로 가져오고 처리
    const modulePromises = courses.map((course) =>
      getCourseToDo(course.id, course.name),
    );

    // Promise.allSettled로 일부 실패해도 계속 진행
    const results = await Promise.allSettled(modulePromises);

    // 3. 결과 병합 (성공한 요청만)
    const thingsToDo = {
      lecture: [],
      assignment: [],
    };

    results.forEach((result) => {
      if (result.status === "fulfilled" && result.value) {
        thingsToDo.lecture.push(...result.value.lecture);
        thingsToDo.assignment.push(...result.value.assignment);
      }
    });

    // 4. 마감기한에 따라 정렬
    thingsToDo.lecture = sortByRemainingTime(thingsToDo.lecture);
    thingsToDo.assignment = sortByRemainingTime(thingsToDo.assignment);

    return thingsToDo;
  } catch (error) {
    return { lecture: [], assignment: [] };
  }
}

// 스크립트 실행 및 결과 반환
getAllCourseAssignments();
