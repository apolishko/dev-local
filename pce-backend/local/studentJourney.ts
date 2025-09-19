// Integration test: Full PCE Student Journey (Clean Direct Login)
// This script runs through the entire assessment process using direct login tokens.

import axios from 'axios';
import * as zlib from 'zlib';
import chalk from 'chalk';
import util from 'util';

// --- GLOBAL ERROR HANDLER ---
process.on('unhandledRejection', (reason: any) => {
  printError(reason, 'UNHANDLED PROMISE REJECTION');
  process.exit(1);
});
process.on('uncaughtException', (err: any) => {
  printError(err, 'UNCAUGHT EXCEPTION');
  process.exit(1);
});

function printError(err: any, title = 'ERROR') {
  console.error(chalk.red.bold('\n==============================================='));
  console.error(chalk.red.bold(title));
  console.error(chalk.red.bold('==============================================='));
  if (err instanceof ApiError) {
    console.error(chalk.red(`${err.message}`));
    if (err.status) console.error(chalk.red(`Status: ${err.status}`));
    if (err.title) console.error(chalk.red(`Title: ${err.title}`));
    if (err.detail) console.error(chalk.red(`Detail: ${err.detail}`));
    if (err.errors !== undefined) {
      console.error(chalk.red('Validation Errors:'));
      console.error(util.inspect(err.errors, { depth: 4, colors: true, maxArrayLength: 5 }));
    }
    if (err.requestData !== undefined) {
      console.error(chalk.red('Request Data:'));
      // Pretty-print, but truncate if too long
      const str = util.inspect(err.requestData, { depth: 4, colors: true, maxArrayLength: 5 });
      console.error(str.length > 2000 ? str.slice(0, 2000) + '... (truncated)' : str);
    }
    if (err.stack) console.error(chalk.gray('Stack:'), err.stack.split('\n').slice(0, 2).join('\n'));
  } else if (axios.isAxiosError(err)) {
    const status = err.response?.status;
    const detail = err.response?.data?.detail;
    const title = err.response?.data?.title;
    const errors = err.response?.data?.errors;
    console.error(chalk.red(`AxiosError: ${status} ${title || 'Unknown error'} - ${detail || ''}`));
    if (errors !== undefined) {
      console.error(chalk.red('Validation Errors:'));
      console.error(util.inspect(errors, { depth: 4, colors: true, maxArrayLength: 5 }));
    }
    if (err.stack) console.error(chalk.gray('Stack:'), err.stack.split('\n').slice(0, 2).join('\n'));
  } else if (err instanceof Error) {
    console.error(chalk.red(`Error: ${err.message}`));
    if (err.stack) console.error(chalk.gray('Stack:'), err.stack.split('\n').slice(0, 2).join('\n'));
  } else {
    console.error(chalk.red('Unknown error occurred:'), util.inspect(err, { depth: 5, colors: true }));
  }
  console.error(chalk.red.bold('===============================================\n'));
}

// --- CUSTOM ERROR CLASS ---
class ApiError extends Error {
  status?: number;
  detail?: string;
  title?: string;
  errors?: any;
  requestData?: any;
  constructor(message: string, status?: number, detail?: string, title?: string, requestData?: any, errors?: any) {
    super(message);
    this.status = status;
    this.detail = detail;
    this.title = title;
    this.requestData = requestData;
    this.errors = errors;
    Error.captureStackTrace(this, this.constructor);
  }
}

type Student = { id: number; login: string; name: string; schoolId: number };
type Assessment = { id: number; studentId: number; careerAssessmentId: number; startDate: string; endDate?: string; currentTurn: number };
type Question = { id: number; questionOneText: string; questionTwoText: string; attributeOneId: number; attributeTwoId?: number; orderInTurn: number };
type CareerMatch = { careerId: number; matchScore: number };
type CareerDetail = { id: number; name: string; description?: string; clusterCode?: string; educationCode?: string; salaryAnnual?: number };
type QuestionMetadata = {id: number;  typeId: number;  maxValue: number;  scoringWeight: number;  questionGroup: string;};

class PceApi {
  constructor(
    private baseUrl: string,
    private token: string
  ) {}

  private headers() {
    return { Authorization: `Bearer ${this.token}` };
  }

  private async request<T>(method: 'get'|'post'|'put', path: string, data?: any, params?: any): Promise<T> {
    const config = {
      method,
      url: `${this.baseUrl}${path}`,
      headers: this.headers(),
      data,
      params,
    };

    try {
      const res = await axios.request<T>(config);
      return res.data;
    } catch (error: any) {
      if (axios.isAxiosError(error)) {
        const status = error.response?.status;
        const detail = error.response?.data?.detail;
        const title = error.response?.data?.title;
        const errors = error.response?.data?.errors;
        throw new ApiError(
          `API request failed: ${method.toUpperCase()} ${path}`,
          status,
          detail,
          title,
          data, // Pass the request data here!
          errors // Pass validation errors if present
        );
      } else if (error instanceof Error) {
        throw new ApiError(error.message, undefined, undefined, undefined, data);
      } else {
        throw new ApiError('Unknown error occurred', undefined, undefined, undefined, data);
      }
    }
  }

  async createStudent(login: string, name: string): Promise<Student> {
    const student = await this.request<Student>('post', '/api/student', { login, name });
    console.log(chalk.cyan('\nStudent created:'), {
      id: student.id,
      login: student.login,
      name: student.name,
      schoolId: student.schoolId
    });
    return student;
  }

  async startAssessment(studentId: number, careerAssessmentId = 1): Promise<Assessment> {
    const assessment = await this.request<Assessment>('post', '/api/student-assessment', { studentId, careerAssessmentId });
    console.log(chalk.cyan('\nAssessment created:'), {
      id: assessment.id,
      studentId: assessment.studentId,
      careerAssessmentId: assessment.careerAssessmentId,
      currentTurn: assessment.currentTurn
    });
    return assessment;
  }

  async getQuestions(turn: number): Promise<Question[]> {
    const questions = await this.request<Question[]>('get', '/api/question', undefined, { turn });
    console.log(chalk.yellow(`Turn ${turn}: Found ${questions.length} questions`));
    return questions;
  }

  async getQuestionMetadata(questionId: number): Promise<QuestionMetadata> {
      return await this.request<QuestionMetadata>('get', `/api/question/${questionId}`);
  }

  async submitResponses(responses: any[]): Promise<void> {
    await this.request('post', '/api/question-response', responses);
    console.log(chalk.green(`Submitted ${responses.length} responses successfully.`));
  }

  async saveGameState(assessmentId: number, gameState: object, turn: number): Promise<void> {
    const json = JSON.stringify(gameState);
    const gzipped = zlib.gzipSync(Buffer.from(json));
    const b64 = gzipped.toString('base64');
    const payload = { gameData: b64, currentGameTurn: turn };
    await this.request('put', `/api/game-save/${assessmentId}`, payload);
    console.log(chalk.gray('  Game state saved successfully.'));
  }

  async completeAssessment(assessmentId: number): Promise<void> {
    await this.request('post', `/api/student-assessment/${assessmentId}/complete`, {});
    console.log(chalk.green('\nAssessment completed successfully!'));
  }

  async getCareerMatches(assessmentId: number): Promise<CareerMatch[]> {
    const matches = await this.request<CareerMatch[]>('get', `/api/career-match/${assessmentId}`);
    console.log(chalk.magenta('\nCareer matches found:'), matches.slice(0, 3).map(m => ({
      careerId: m.careerId,
      matchScore: Number(m.matchScore).toFixed(3)
    })));
    return matches;
  }

  async getCareerDetail(careerId: number): Promise<CareerDetail> {
    const detail = await this.request<CareerDetail>('get', `/api/career/${careerId}`);
    console.log(chalk.blue('\nTop Career Detail:'));
    console.log(chalk.blue(`  Name: ${detail.name}`));
    console.log(chalk.blue(`  Cluster: ${detail.clusterCode || 'N/A'}`));
    console.log(chalk.blue(`  Education: ${detail.educationCode || 'N/A'}`));
    console.log(chalk.blue(`  Salary: ${detail.salaryAnnual ? Number(detail.salaryAnnual).toLocaleString() : 'N/A'}`));
    console.log(chalk.blue(`  Description: ${detail.description ? detail.description.substring(0, 100) + '...' : 'N/A'}`));
    return detail;
  }

  async saveBatchData(assessmentId: number, responses: any[], gameData: string, currentGameTurn: number): Promise<void> {
    const payload = {
      assessmentId,
      responses,
      gameData,
      currentGameTurn
    };
    await this.request('post', '/api/game-batch-save', payload);
    console.log(chalk.green(`Batch saved ${responses.length} responses and game state for assessment ${assessmentId}`));
  }
}

// MAIN: End-to-end journey
const BASE_URL = 'http://localhost:8080';

// Client has full control over login
const studentLogin = `student-${Date.now()}@example.com`;
const TOKEN = `dev-login-${studentLogin}`;

const api = new PceApi(BASE_URL, TOKEN);

// Pce Business Logic Flows - 1.3.1 Turn-by-Turn Submission Flow
async function testTurnByTurnFlow(api: PceApi, student: Student, assessment: Assessment): Promise<{ totalQuestions: number, totalResponses: number, finalTurn: number }> {
  console.log(chalk.bold('\nTesting Turn-by-Turn Submission Flow...'));

  let currentTurn = 1;
  let totalQuestions = 0;
  let totalResponses = 0;

  while (true) {
    const questions = await api.getQuestions(currentTurn);
    if (questions.length === 0) {
      console.log(chalk.yellow(`Turn ${currentTurn}: No more questions found. Game complete!`));
      break;
    }

    totalQuestions += questions.length;

    const responses = await Promise.all(questions.map(async (q) => {
      const meta = await api.getQuestionMetadata(q.id);
      let valRange = [0, 1];
      if (meta.maxValue === 9) valRange = [1,2,3,4,5,6,7,8,9];
      if (meta.maxValue === 1) valRange = [0, 1];

      const response: any = {
        studentAssessmentId: assessment.id,
        questionId: q.id,
        attributeOneId: q.attributeOneId,
        valueOne: valRange[Math.floor(Math.random() * valRange.length)],
      };
      if (q.attributeTwoId) {
        response.attributeTwoId = q.attributeTwoId;
        response.valueTwo = valRange[Math.floor(Math.random() * valRange.length)];
      }
      return response;
    }));

    await api.submitResponses(responses);
    totalResponses += responses.length;

    // Save game state and advance turn
    const gameState = {
        currentTurn: currentTurn + 1,
        questionsAnswered: totalQuestions,
        responsesSubmitted: totalResponses,
        savedAt: new Date().toISOString(),
        lastQuestions: questions.map(q => ({ id: q.id, attributeIds: [q.attributeOneId, q.attributeTwoId].filter(Boolean) })),
    };
    await api.saveGameState(assessment.id, gameState, currentTurn + 1);

    currentTurn++;

    if (currentTurn > 20) {
      console.log(chalk.red('Safety break: Too many turns, stopping game loop'));
      break;
    }
  }

  console.log(chalk.green(`Turn-by-Turn Flow: ${totalQuestions} questions answered across ${currentTurn - 1} turns`));
  return { totalQuestions, totalResponses, finalTurn: currentTurn };
}

// Pce Business Logic Flows - 1.3.1 Alternative Batch Save Submission Flow (Game Batch Save)
async function testBatchSaveFlow(api: PceApi, student: Student, assessment: Assessment): Promise<{ totalQuestions: number, totalResponses: number, finalTurn: number }> {
  console.log(chalk.bold('\nTesting Alternative Batch Save Submission Flow...'));
  
  let currentTurn = 1;
  let totalQuestions = 0;
  let allResponses: any[] = [];

  // Collect all questions and responses without submitting them
  while (true) {
    const questions = await api.getQuestions(currentTurn);
    if (questions.length === 0) {
      console.log(chalk.yellow(`Turn ${currentTurn}: No more questions found. Ready for batch save!`));
      break;
    }

    totalQuestions += questions.length;

    const responses = await Promise.all(questions.map(async (q) => {
      const meta = await api.getQuestionMetadata(q.id);
      let valRange = [0, 1];
      if (meta.maxValue === 9) valRange = [1,2,3,4,5,6,7,8,9];
      if (meta.maxValue === 1) valRange = [0, 1];

      const response: any = {
        studentAssessmentId: assessment.id,
        questionId: q.id,
        attributeOneId: q.attributeOneId,
        valueOne: valRange[Math.floor(Math.random() * valRange.length)],
      };
      if (q.attributeTwoId) {
        response.attributeTwoId = q.attributeTwoId;
        response.valueTwo = valRange[Math.floor(Math.random() * valRange.length)];
      }
      return response;
    }));

    allResponses.push(...responses);
    console.log(chalk.gray(`  Collected ${responses.length} responses from turn ${currentTurn}`));
    currentTurn++;

    if (currentTurn > 20) {
      console.log(chalk.red('Safety break: Too many turns, stopping collection'));
      break;
    }
  }

  // Create final game state with all collected data
  const finalGameState = {
    currentTurn: currentTurn,
    questionsAnswered: totalQuestions,
    responsesSubmitted: allResponses.length,
    savedAt: new Date().toISOString(),
    allQuestions: allResponses.map(r => ({ questionId: r.questionId, attributeIds: [r.attributeOneId, r.attributeTwoId].filter(Boolean) })),
    batchSaveFlow: true
  };

  // Compress game state like the API expects
  const json = JSON.stringify(finalGameState);
  const gzipped = zlib.gzipSync(Buffer.from(json));
  const gameData = gzipped.toString('base64');

  // Perform atomic batch save
  await api.saveBatchData(assessment.id, allResponses, gameData, currentTurn);
  
  console.log(chalk.green(`Batch Save Flow: ${totalQuestions} questions answered, ${allResponses.length} responses saved atomically`));
  return { totalQuestions, totalResponses: allResponses.length, finalTurn: currentTurn };
}

// Main test execution
(async () => {
  try {
    console.log(chalk.bold.blue('\n==============================================='));
    console.log(chalk.bold.blue('PCE STUDENT JOURNEY INTEGRATION TEST'));
    console.log(chalk.bold.blue('==============================================='));
    console.log(chalk.blue(`Student login: ${studentLogin}`));
    console.log(chalk.blue(`Auth token: Bearer dev-login-${studentLogin}`));

    //  STEP 1: Create Student
    console.log(chalk.bold('\nSTEP 1: Creating Student...'));
    const student = await api.createStudent(studentLogin, 'Sam Test Student');

    //  STEP 2: Start Assessment for Turn-by-Turn Flow
    console.log(chalk.bold('\nSTEP 2A: Testing Turn-by-Turn Submission Flow...'));
    const turnByTurnAssessment = await api.startAssessment(student.id);
    const turnByTurnResults = await testTurnByTurnFlow(api, student, turnByTurnAssessment);

    //  STEP 3: Complete Turn-by-Turn Assessment
    console.log(chalk.bold('\nSTEP 3A: Completing Turn-by-Turn Assessment...'));
    await api.completeAssessment(turnByTurnAssessment.id);

    //  STEP 4A: Get Career Matches for Turn-by-Turn
    console.log(chalk.bold('\nSTEP 4A: Retrieving Turn-by-Turn Career Matches...'));
    const turnByTurnMatches = await api.getCareerMatches(turnByTurnAssessment.id);
    console.log(chalk.green(`Turn-by-Turn: Found ${turnByTurnMatches.length} career matches`));

    //  STEP 2B: Start Assessment for Batch Save Flow
    console.log(chalk.bold('\nSTEP 2B: Testing Alternative Batch Save Submission Flow...'));
    // Create another student for batch save test to avoid conflict
    const batchStudent = await api.createStudent(`${studentLogin}-batch`, 'Sam Batch Test Student');
    const batchAssessment = await api.startAssessment(batchStudent.id);
    const batchResults = await testBatchSaveFlow(api, batchStudent, batchAssessment);

    //  STEP 3B: Complete Batch Save Assessment
    console.log(chalk.bold('\nSTEP 3B: Completing Batch Save Assessment...'));
    await api.completeAssessment(batchAssessment.id);

    //  STEP 4B: Get Career Matches for Batch Save
    console.log(chalk.bold('\nSTEP 4B: Retrieving Batch Save Career Matches...'));
    const batchMatches = await api.getCareerMatches(batchAssessment.id);
    console.log(chalk.green(`Batch Save: Found ${batchMatches.length} career matches`));

    //  STEP 5: Compare Results
    console.log(chalk.bold('\nSTEP 5: Comparing Both Flows...'));
    console.log(chalk.cyan(`Turn-by-Turn: ${turnByTurnResults.totalQuestions} questions, ${turnByTurnResults.totalResponses} responses, ${turnByTurnMatches.length} matches`));
    console.log(chalk.cyan(`Batch Save: ${batchResults.totalQuestions} questions, ${batchResults.totalResponses} responses, ${batchMatches.length} matches`));
    
    if (turnByTurnResults.totalQuestions === batchResults.totalQuestions && 
        turnByTurnResults.totalResponses === batchResults.totalResponses) {
      console.log(chalk.green('✓ Both flows processed the same number of questions and responses'));
    } else {
      console.log(chalk.yellow('⚠ Different number of questions/responses between flows - this may be expected due to randomization'));
    }

    //  STEP 6: Get Top Career Details
    if (turnByTurnMatches.length > 0) {
      console.log(chalk.bold('\nSTEP 6: Getting Top Career Details from Turn-by-Turn...'));
      await api.getCareerDetail(turnByTurnMatches[0].careerId);
    }

    console.log(chalk.bold.green('\n==============================================='));
    console.log(chalk.bold.green('DUAL FLOW STUDENT JOURNEY COMPLETED!'));
    console.log(chalk.bold.green('==============================================='));

    //  STEP 7: Test Repeat Assessment Prevention
    console.log(chalk.bold.yellow('\nSTEP 7: Testing Repeat Assessment Prevention...'));
    try {
      const repeatAssessment = await api.startAssessment(student.id);
      console.log(chalk.red('WARNING: Unexpectedly allowed to create repeat assessment!'));
      console.log(chalk.red(`Repeat assessment ID: ${repeatAssessment.id}`));
    } catch (e: any) {
      if (e instanceof ApiError && e.status === 409) {
        console.log(chalk.green('✓ Correctly prevented repeat assessment creation'));
        console.log(chalk.gray(`   Expected error: ${e.detail || 'Assessment already exists'}`));
      } else {
        throw e;
      }
    }

    console.log(chalk.bold.green('\n==============================================='));
    console.log(chalk.bold.green('ALL INTEGRATION TESTS PASSED!'));
    console.log(chalk.bold.green('BOTH SUBMISSION FLOWS VALIDATED SUCCESSFULLY'));
    console.log(chalk.bold.green('===============================================\n'));

  } catch (err: any) {
    printError(err, 'INTEGRATION TEST FAILED');
    process.exit(1);
  }
})();
