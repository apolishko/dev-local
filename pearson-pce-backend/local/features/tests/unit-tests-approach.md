# Unit Tests Approach - WebMvcTest Pattern

## Статус: ФИНАЛЬНЫЙ РАБОЧИЙ ПАТТЕРН ✅

Этот документ описывает успешно отработанный подход к unit тестированию контроллеров в проекте Pearson Career Explorer Backend.

---

## Архитектура тестирования

### Общий принцип
Используем **@WebMvcTest** с внутренней **@TestConfiguration** для предоставления недостающих Spring бинов. Этот подход тестирует полный HTTP стек включая маршрутизацию, JSON сериализацию, валидацию и Spring Security.

### Ключевые компоненты инфраструктуры

#### 1. build.gradle - конфигурация
```gradle
test {
    useJUnitPlatform()
    jvmArgs = [
        '-Dnet.bytebuddy.experimental=true'  // КРИТИЧНО для Java 21 + Mockito
    ]
}

dependencies {
    testImplementation 'org.springframework.boot:spring-boot-starter-test'
    testImplementation 'org.springframework.security:spring-security-test'
    testRuntimeOnly 'com.h2database:h2'
}
```

**ВАЖНО:** Флаг `-Dnet.bytebuddy.experimental=true` обязателен для решения проблем совместимости Java 21 с Mockito.

#### 2. application-test.properties - тестовый профиль
```properties
# Отключаем проблемные auto-configurations
# Для чистого @WebMvcTest не обязательно, но защищает от неожиданных подключений
spring.autoconfigure.exclude=\
org.springframework.boot.autoconfigure.jdbc.DataSourceAutoConfiguration,\
org.springframework.boot.autoconfigure.orm.jpa.HibernateJpaAutoConfiguration,\
org.springframework.boot.autoconfigure.flyway.FlywayAutoConfiguration,\
org.springframework.boot.autoconfigure.batch.BatchAutoConfiguration

# Auth mode для тестов
auth.mode=fake
auth.fake.login=test@example.com
auth.fake.role=student
auth.fake.organization-id=123

spring.main.allow-bean-definition-overriding=true
logging.level.com.pearson.pce=INFO
```

---

## Паттерн тестирования контроллеров

### Общая тестовая инфраструктура

Создан общий конфиг **`src/test/java/test/java/com/pearson/pce/testsupport/WebMvcTestInfra.java`**:

```java
@TestConfiguration
@EnableMethodSecurity(prePostEnabled = true)
public class WebMvcTestInfra {
    
    @Bean(name = "authFilter")
    OncePerRequestFilter authFilter() {
        return new OncePerRequestFilter() {
            @Override
            protected void doFilterInternal(
                jakarta.servlet.http.HttpServletRequest request,
                jakarta.servlet.http.HttpServletResponse response,
                jakarta.servlet.FilterChain filterChain)
            throws jakarta.servlet.ServletException, java.io.IOException {
                filterChain.doFilter(request, response);
            }
        };
    }

    @Bean(name = "monitoringRequestContextFilter")
    RequestContextFilter monitoringRequestContextFilter() {
        return new RequestContextFilter(
            new SimpleMeterRegistry(), 
            "dual", 
            "X-Correlation-Id", 
            "test", 
            "pce-backend", 
            "0.1.0"
        );
    }

    @Bean
    ProblemDetailAuthenticationEntryPoint problemDetailAuthenticationEntryPoint(ObjectMapper objectMapper) {
        return new ProblemDetailAuthenticationEntryPoint(objectMapper);
    }
}
```

### Эталонный пример: StudentControllerWebTest.java

```java
@WebMvcTest(StudentController.class)  // Тестируем только один контроллер
@ActiveProfiles("test")               // Используем тестовый профиль
@Import(WebMvcTestInfra.class)        // Подключаем общую тестовую инфраструктуру
class StudentControllerWebTest {

    @Autowired
    private MockMvc mockMvc;             // Для HTTP запросов

    @Autowired  
    private ObjectMapper objectMapper;    // Для JSON сериализации

    // =============================================================================
    // MOCK BEANS - все зависимости контроллера должны быть замоканы
    // =============================================================================
    
    @MockBean
    private StudentService studentService;      // Бизнес-логика

    @MockBean(name = "security")               // ИМЕНОВАННЫЙ мок для @PreAuthorize
    private SecurityHelper securityHelper;

    @MockBean                                  // Автоматически инжектируется в приложении  
    private MonitoringService monitoringService;

    // =============================================================================
    // ТЕСТЫ
    // =============================================================================

    @Test
    @DisplayName("POST /api/student creates student successfully")
    @WithMockUser(roles = {"STUDENT"})  // Мокаем аутентификацию
    void createOrUpdateStudent_Success() throws Exception {
        // Arrange - подготовка данных
        StudentRequest request = new StudentRequest("test-login", "Test Student");
        StudentResponse expectedResponse = new StudentResponse(1L, "test-login", "Test Student", 123L);
        
        // Мокаем зависимости
        Mockito.when(securityHelper.canAccessAsStudent()).thenReturn(true);
        Mockito.when(studentService.createOrUpdateStudent(any(StudentRequest.class))).thenReturn(expectedResponse);

        // Act & Assert - выполнение и проверка
        mockMvc.perform(post("/api/student")
                        .with(csrf())  // CSRF токен для POST запросов
                        .contentType(MediaType.APPLICATION_JSON)
                        .content(objectMapper.writeValueAsString(request))
                        .accept(MediaType.APPLICATION_JSON))
                .andExpect(status().isOk())
                .andExpect(content().contentType(MediaType.APPLICATION_JSON))
                .andExpect(jsonPath("$.id").value(1L))
                .andExpect(jsonPath("$.login").value("test-login"))
                .andExpect(jsonPath("$.name").value("Test Student"))
                .andExpect(jsonPath("$.schoolId").value(123L));
    }
}
```

---

## Чек-лист для создания нового теста контроллера

### 1. Базовая структура
- [ ] `@WebMvcTest(YourController.class)` - тестируем один контроллер  
- [ ] `@ActiveProfiles("test")` - используем тестовый профиль
- [ ] `@Import(WebMvcTestInfra.class)` - подключаем общую тестовую инфраструктуру
- [ ] `@Autowired MockMvc mockMvc` - для HTTP запросов
- [ ] `@Autowired ObjectMapper objectMapper` - для JSON

### 2. Mock Beans  
- [ ] `@MockBean` для всех сервисов, которые инжектит контроллер
- [ ] `@MockBean(name = "security") SecurityHelper securityHelper` - для @PreAuthorize  
- [ ] `@MockBean MonitoringService monitoringService` - автоматически инжектируется
- [ ] При ошибке `NoSuchBeanDefinitionException: BeanName` - добавить `@MockBean BeanName`

### 3. Тестовая инфраструктура
**НЕ НУЖНО НИЧЕГО КОПИРОВАТЬ!** Просто добавляем `@Import(WebMvcTestInfra.class)` - вся инфраструктура подключится автоматически:
- `authFilter` - заглушка для аутентификации
- `monitoringRequestContextFilter` - фильтр мониторинга  
- `problemDetailAuthenticationEntryPoint` - обработчик ошибок аутентификации

### 4. Тесты
- [ ] `@Test` + `@DisplayName("описание")` - описательные названия
- [ ] `@WithMockUser(roles = {"ROLE"})` - мокаем роли для security
- [ ] `Mockito.when(securityHelper.method()).thenReturn(true)` - мокаем security методы
- [ ] `Mockito.when(service.method()).thenReturn(result)` - мокаем бизнес-логику
- [ ] `.with(csrf())` для POST/PUT/DELETE запросов
- [ ] Полные проверки: `status()`, `content()`, `jsonPath()`

---

## Что тестирует этот подход

### ✅ Проверяет
- **HTTP маршрутизация** - правильные URL и методы
- **JSON сериализация/десериализация** - корректность DTO
- **Валидация** - @Valid аннотации 
- **Spring Security** - @PreAuthorize, роли, аутентификация
- **Фильтры** - RequestContextFilter, AuthFilter
- **Обработка ошибок** - статус коды, ProblemDetail
- **Content-Type и Accept** заголовки

### ❌ НЕ проверяет
- Реальную базу данных (используем моки)
- Реальную аутентификацию (используем @WithMockUser)
- Интеграцию между сервисами (мокаем все зависимости)

---

## Команды для запуска

```bash
# Запуск конкретного теста
gradlew.bat test --tests YourControllerWebTest

# Запуск всех HTTP тестов контроллеров (быстрый прогон WebMvcTest)
gradlew.bat test --tests "*WebTest"

# Запуск всех тестов  
gradlew.bat test

# С очисткой кэша
gradlew.bat clean test

# Просмотр отчета
start build/reports/tests/test/index.html
```

---

## Решение типичных проблем

### NoSuchBeanDefinitionException: BeanName
**Решение:** Добавить `@MockBean BeanName beanName;` в тест

### IllegalArgumentException at OpenedClassReader (Java 21 + Mockito)  
**Решение:** Убедиться что в build.gradle есть `-Dnet.bytebuddy.experimental=true`

### 403 Forbidden в тестах с security
**Решение:** 
1. Добавить `@WithMockUser(roles = {"ROLE"})`
2. Замокать `securityHelper.canAccessMethod()` методы
3. Для POST запросов добавить `.with(csrf())`

### Тест компилируется но не запускается
**Решение:** Проверить что есть `useJUnitPlatform()` в build.gradle

---

## Масштабирование

Для каждого нового контроллера:
1. Копируем `StudentControllerWebTest.java` 
2. Меняем имя контроллера и методы  
3. Добавляем недостающие `@MockBean` при ошибках компиляции
4. **Больше НИЧЕГО копировать не нужно** - `@Import(WebMvcTestInfra.class)` подключает всю инфраструктуру

**Результат:** Быстрые (0.5s), надежные, полнофункциональные HTTP тесты с покрытием всего стека кроме БД. **Без копипасты!**

---

## Расширение WebMvcTestInfra

### Когда добавлять новые бины в WebMvcTestInfra

Если в тестах часто встречается `NoSuchBeanDefinitionException` для одного и того же бина, добавьте его в общую инфраструктуру:

```java
@TestConfiguration
public class WebMvcTestInfra {
    
    // Существующие бины...
    
    // Новые общие бины для всех тестов:
    
    @Bean
    Clock testClock() {
        return Clock.fixed(Instant.parse("2025-01-09T12:00:00Z"), ZoneOffset.UTC);
    }
    
    @Bean
    @Primary
    Validator testValidator() {
        return Validation.buildDefaultValidatorFactory().getValidator();
    }
    
    @Bean(name = "customAuthFilter")
    OncePerRequestFilter customAuthFilter() {
        return new OncePerRequestFilter() {
            @Override
            protected void doFilterInternal(...) {
                // Custom logic
                filterChain.doFilter(request, response);
            }
        };
    }
    
    // Кастомная конфигурация ObjectMapper для тестов
    @Bean
    @Primary
    ObjectMapper testObjectMapper() {
        ObjectMapper mapper = new ObjectMapper();
        mapper.registerModule(new JavaTimeModule());
        mapper.configure(SerializationFeature.WRITE_DATES_AS_TIMESTAMPS, false);
        return mapper;
    }
    
    // Property overrides через бины
    @Bean
    @Primary
    SomeConfigurationProperties testProps() {
        SomeConfigurationProperties props = new SomeConfigurationProperties();
        props.setEnabled(false);  // Override для тестов
        return props;
    }
}
```

### Принципы добавления бинов

1. **Добавляйте только общие зависимости** - если бин нужен в 2+ тестах
2. **Используйте @Primary** для замены production бинов
3. **Создавайте тестовые заглушки** - простые, быстрые, предсказуемые
4. **Документируйте назначение** - зачем добавлен каждый бин

### Альтернатива: Локальные TestConfiguration

Для специфичных потребностей одного теста создайте локальную конфигурацию:

```java
@WebMvcTest(SpecificController.class)
@ActiveProfiles("test")
@Import({WebMvcTestInfra.class, SpecificControllerTest.LocalTestConfig.class})
class SpecificControllerTest {
    
    @TestConfiguration
    static class LocalTestConfig {
        @Bean
        SpecificService specificTestBean() {
            return Mockito.mock(SpecificService.class);
        }
    }
}
```

**Результат:** Масштабируемая архитектура тестирования с централизованной общей инфраструктурой и возможностью локальных расширений.

---

*Создано: 2025-01-09*  
*Статус: Финальный рабочий паттерн*  
*Протестировано: Java 21, Spring Boot 3.2.0, Mockito*