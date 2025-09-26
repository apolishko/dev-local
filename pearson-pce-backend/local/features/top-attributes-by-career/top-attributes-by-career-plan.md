# План: Endpoint `GET /api/top-attributes-by-career/{careerId}`

Цель: отдать топ‑N важных атрибутов/скиллов для конкретной карьеры, ранжированных по z‑score, с фиксированным порогом важности `z_score_value > 1.0`. Поддержать необязательный фильтр `questionTypeId`, аналогичный существующему `/api/top-careers-by-attribute`.

## Требования и поведение

- Endpoint: `GET /api/top-attributes-by-career/{careerId}?limit={n}&questionTypeId={id?}`
- Аутентификация: стандартный JWT, доступ любому аутентифицированному пользователю (`@PreAuthorize("@security.canAccessAnyResource()")`).
- Валидации:
  - 404, если карьера не существует.
  - `limit` — опционален, `min=1`, значение по умолчанию: 999999 (большое число, как в существующем getTopCareersByAttribute).
  - `questionTypeId` — опционален; если задан, ограничиваем атрибуты теми, что реально встречаются в вопросах этого типа, и z‑score берём только для связанной `question_group`.
- Фильтры данных:
  - Всегда исключаем `attribute.exclude_from_matching = FALSE` (только используемые в матчинг атрибуты).
  - Всегда применяем порог важности: `caz.z_score_value > 1.0`.
  - Если атрибут встречается в нескольких `question_group` для карьеры — дедуп по атрибуту: берём максимум `z_score_value` (т.е. лучший вклад).
- Ошибки/респонсы:
  - 200: объект с `careerId`, `careerName` и массивом топ‑атрибутов.
  - Пустой список `topAttributes` допустим (если нет значимых атрибутов > 1.0).

## Контракт ответа (DTO)

JSON пример:
```json
{
  "careerId": 501,
  "careerName": "Civil Engineer",
  "topAttributes": [
    { "attributeId": 42, "attributeName": "Public Speaking", "rankScore": 2.21 },
    { "attributeId": 100, "attributeName": "Leadership", "rankScore": 1.94 }
  ]
}
```

Java DTOs (все имена и код — на английском):
```java
// package: com.pearson.pce.api.dto
public record AttributeRank(Long attributeId, String attributeName, BigDecimal rankScore) {}

public record TopAttributesByCareerResponse(
    Long careerId,
    String careerName,
    List<AttributeRank> topAttributes
) {}
```

## Изменения по файлам

- `src/main/java/com/pearson/pce/api/CareerController.java`
  - Добавить метод:
  ```java
  @GetMapping("/top-attributes-by-career/{careerId}")
  @PreAuthorize("@security.canAccessAnyResource()")
  public ResponseEntity<TopAttributesByCareerResponse> getTopAttributesByCareer(
      @PathVariable Long careerId,
      @RequestParam(required = false) @Min(1) Integer limit,
      @RequestParam(required = false) Long questionTypeId
  )
  ```
  - Аннотации OpenAPI (summary/description/examples), CommonErrorResponses (Auth + NotFound + ValidationError).
  - Добавить логирование как в существующем методе getTopCareersByAttribute.

- `src/main/java/com/pearson/pce/service/CareerService.java`
  - Новый метод:
  ```java
  @Transactional(readOnly = true)
  @PreAuthorize("@security.canAccessAnyResource()")
  public TopAttributesByCareerResponse getTopAttributesByCareer(Long careerId, Long questionTypeId, Integer limit)
  ```
  - Шаги внутри:
    1) Проверить существование карьеры + получить её имя (для ответа). Если нет — `ResourceNotFoundException`.
    2) Нормализовать `limit` (default 5).
    3) Если `questionTypeId == null` → выполнить SQL A (см. ниже). Иначе → SQL B.
    4) Смаппить результат в `List<AttributeRank>` и вернуть `TopAttributesByCareerResponse`.

- `src/main/java/com/pearson/pce/api/dto/` — добавить два DTO (см. выше).

- Документация: `documents/srs/Pce Api Spec v.0.3.txt` — добавить новый раздел эндпоинта (см. раздел «Обновление API Spec» ниже).

База данных/миграции: не требуются (используем существующие таблицы и индексы: `career_attribute_zscore` с PK `(career_id, attribute_id, question_group)` и индексом по `question_group`).

## SQL

Обозначения:
- `caz` = `career_attribute_zscore`
- `a` = `attribute`

Важно: всегда фильтруем `a.exclude_from_matching = FALSE` и `caz.z_score_value > 1.0`. Сортируем по `rank_score` убыв.

### SQL A — без `questionTypeId` (агрегация по группам)

Берём максимум z‑score по атрибуту среди всех `question_group` для данной карьеры:

```sql
WITH z AS (
  SELECT
    caz.attribute_id,
    MAX(caz.z_score_value) AS rank_score
  FROM career_attribute_zscore caz
  JOIN attribute a ON a.id = caz.attribute_id
  WHERE
    caz.career_id = ?
    AND a.exclude_from_matching = FALSE
    AND caz.z_score_value > 1.0
  GROUP BY caz.attribute_id
)
SELECT
  a.id   AS attribute_id,
  a.name AS attribute_name,
  z.rank_score
FROM z
JOIN attribute a ON a.id = z.attribute_id
ORDER BY z.rank_score DESC
LIMIT ?;
```

Параметры: `[careerId, limit]`.

### SQL B — с `questionTypeId`

1) Определяем `question_group` для типа вопроса.
2) Ограничиваем атрибуты теми, что реально встречаются в вопросах заданного типа.
3) Берём z‑score только для этой `question_group` (а не максимум по всем).

```sql
WITH target_group AS (
  SELECT qt.question_group
  FROM question_type qt
  WHERE qt.id = ?
),
attrs_for_type AS (
  SELECT DISTINCT attr.attribute_id
  FROM question q
  CROSS JOIN LATERAL (VALUES (q.attribute_one_id), (q.attribute_two_id)) AS attr(attribute_id)
  WHERE q.type_id = ?
    AND attr.attribute_id IS NOT NULL
)
SELECT
  a.id            AS attribute_id,
  a.name          AS attribute_name,
  caz.z_score_value AS rank_score
FROM career_attribute_zscore caz
JOIN target_group tg ON tg.question_group = caz.question_group
JOIN attrs_for_type aft ON aft.attribute_id = caz.attribute_id
JOIN attribute a ON a.id = caz.attribute_id
WHERE
  caz.career_id = ?
  AND a.exclude_from_matching = FALSE
  AND caz.z_score_value > 1.0
ORDER BY caz.z_score_value DESC
LIMIT ?;
```

Параметры: `[questionTypeId, questionTypeId, careerId, limit]`.

Примечания:
- Если `questionTypeId` указывает на тип, который не используется данной карьерой → вернём пустой список (это ок).
- Отдельной явной валидации существования `questionTypeId` можно не делать (но можно добавить 404/400 — по решению команды).

## Контроллер (эскиз)

```java
@Operation(
    summary = "Top-N important attributes for a career",
    description = "Returns top-N attributes for the specified career, ranked by z-score (z>1.0). Optionally filter by question type."
)
@ApiResponse(responseCode = "200", description = "Top attributes returned")
@CommonErrorResponses.AuthAndNotFound
@GetMapping("/top-attributes-by-career/{careerId}")
@PreAuthorize("@security.canAccessAnyResource()")
public ResponseEntity<TopAttributesByCareerResponse> getTopAttributesByCareer(
    @PathVariable Long careerId,
    @RequestParam(required = false) @Min(1) Integer limit,
    @RequestParam(required = false) Long questionTypeId
) {
    TopAttributesByCareerResponse res = careerService.getTopAttributesByCareer(careerId, questionTypeId, limit);
    return ResponseEntity.ok(res);
}
```

## Сервис (эскиз)

```java
@Transactional(readOnly = true)
@PreAuthorize("@security.canAccessAnyResource()")
public TopAttributesByCareerResponse getTopAttributesByCareer(Long careerId, Long questionTypeId, Integer limit) {
    logger.info("getTopAttributesByCareer called with careerId={}, questionTypeId={}, limit={}", careerId, questionTypeId, limit);
    
    // 1) validate career exists + fetch name
    var career = dsl.select(CAREER.ID, CAREER.NAME)
        .from(CAREER)
        .where(CAREER.ID.eq(careerId))
        .fetchOne();
    if (career == null) throw new ResourceNotFoundException("Career not found");

    int top = (limit != null ? limit : 999999);

    String sql = (questionTypeId == null) ? buildSqlA() : buildSqlB();
    Object[] params = (questionTypeId == null)
        ? new Object[]{ careerId, top }
        : new Object[]{ questionTypeId, questionTypeId, careerId, top };

    logger.info("Generated SQL: {}", sql);
    logger.info("SQL Parameters: {}", java.util.Arrays.toString(params));
    
    Result<Record> rows = dsl.fetch(sql, params);
    logger.info("Query returned {} records", rows.size());
    List<AttributeRank> attrs = rows.stream()
        .map(r -> new AttributeRank(
            r.get("attribute_id", Long.class),
            r.get("attribute_name", String.class),
            r.get("rank_score", BigDecimal.class)
        ))
        .toList();

    return new TopAttributesByCareerResponse(
        career.get(CAREER.ID),
        career.get(CAREER.NAME),
        attrs
    );
}
```

## Обновление API Spec (documents/srs/Pce Api Spec v.0.3.txt)

Добавить раздел в Read API:

```
GET /api/top-attributes-by-career/{careerId}
// summary: Get top attributes for a specific career
// description: Returns top-N most important attributes for the specified career, ranked by z-score. Includes only attributes with z_score_value > 1.0 and exclude_from_matching = false. Optionally filter attributes by question type to show only those used in that group. Used for the Career Overview card on the UI.
// Query Parameters:
//   - questionTypeId (optional): Filter attributes to those used by this question type
//   - limit (optional, min=1): Limit top N attributes (default: all matching attributes)
// Auth: Any authenticated user
// Res ▶ {
//   "careerId": 501,
//   "careerName": "Civil Engineer",
//   "topAttributes": [
//     { "attributeId": 42, "attributeName": "Public Speaking", "rankScore": 2.21 },
//     { "attributeId": 100, "attributeName": "Leadership", "rankScore": 1.94 }
//   ]
// }
// Examples:
//   GET /api/top-attributes-by-career/501
//   GET /api/top-attributes-by-career/501?limit=5
//   GET /api/top-attributes-by-career/501?questionTypeId=1&limit=10
```



## Производительность

- `career_attribute_zscore` имеет PK `(career_id, attribute_id, question_group)` и индекс по `question_group`; запросы фильтруют по `career_id` (селективно), соединения лёгкие.
- Лимит `LIMIT ?` на верхушке — отдаём только нужное топ‑N.

## Итоги

Готовы к имплементации: добавить DTO, сервисный метод с двумя SQL вариантами, контроллер с параметрами и аннотациями, блок документации в API Spec. Никаких миграций БД. Строгий порог `z_score_value > 1.0`, единственный опциональный фильтр — `questionTypeId`.
Важно: Не забываем про swagger!!! Смотрим какой у нас механизм работы с ним.


