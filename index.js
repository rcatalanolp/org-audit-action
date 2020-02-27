const core = require('@actions/core');
const artifact = require('@actions/artifact');
const github = require('@actions/github');
const { graphql } = require("@octokit/graphql");
const csvToMarkdown = require('csv-to-markdown-table');
const fs = require('fs');
const os = require('os');
const { promisify } = require('util')

const { organizationQuery, enterpriseQuery } = require('./queries');

const writeFileAsync = promisify(fs.writeFile)

const ARTIFACT_FILE_NAME = 'raw-data';
const DATA_FOLDER = './data';
const ERROR_MESSAGE_ARCHIVED_REPO = "Must have push access to view repository collaborators."

!fs.existsSync(DATA_FOLDER) && fs.mkdirSync(DATA_FOLDER);

function JSONtoCSV(json) {
  var keys = ["enterprise", "organization", "repo", "user", "login", "permission"];
  var csv = keys.join(',') + os.EOL;
  
  json.forEach(function(record) {
		keys.forEach(function(_, i) {
			csv += record[i]
			if(i!=keys.length - 1) csv += ',';
		});
		csv += os.EOL;
  });
  
  return csv;
}

class CollectUserData {
  constructor(token, organization, enterprise, options) {
    this.validateInput(organization, enterprise);

    this.organizations = [{ login: organization }];
    this.enterprise = enterprise;
    this.options = options; 
    this.result = options.data || {};
    this.normalizedData = []

    this.initiateGraphQLClient(token);
    this.initiateOctokit(token);
  }
  
  validateInput(organization, enterprise) {
    if (organization && enterprise) {
      core.setFailed('The organization and enterprise parameter are mutually exclusive.');
      process.exit();
    }
  }

  async createandUploadArtifacts() {
    if (!process.env.GITHUB_RUN_NUMBER) {
      return core.debug('not running in actions, skipping artifact upload')
    }

    const artifactClient = artifact.create()
    const artifactName = `user-report-${new Date().getTime()}`;
    const files = [
      `./data/${ARTIFACT_FILE_NAME}.json`,
      `./data/${ARTIFACT_FILE_NAME}.csv`
    ]
    const rootDirectory = './'
    const options = { continueOnError: true }

    const uploadResult = await artifactClient.uploadArtifact(artifactName, files, rootDirectory, options)
    return uploadResult;
  }

  async postResultsToIssue(csv) {
    if (!this.options.postToIssue) {
      return core.info(`Skipping posting result to issue ${this.options.repository}.`);
    }

    const [owner, repo] = this.options.repository.split('/');
    let body = await csvToMarkdown(csv, ",", true)

    core.info(`Posting result to issue ${this.options.repository}.`);
    const { data: issue_response } = await this.octokit.issues.create({
      owner,
      repo,
      "title": `Audit log report for ${new Date().toLocaleString()}`,
      "body": body
    });

    core.info(issue_response);
    await this.octokit.issues.update({
      owner,
      repo,
      "issue_number" : issue_response.number,
      "state": "closed"
    });
  }

  initiateGraphQLClient(token) {
    this.graphqlClient = graphql.defaults({
      headers: {
        authorization: `token ${token}`
      }
    });
  }

  initiateOctokit(token) {
    this.octokit = new github.GitHub(token);
  }
  
  async requestEnterpriseData() {
    const { enterprise } = await this.graphqlClient(enterpriseQuery, { enterprise: this.enterprise });
    return enterprise;
  }

  async requestOrganizationData (organization, collaboratorsCursor = null, repositoriesCursor = null) {
    try {
      const { organization: data } = await this.graphqlClient(organizationQuery, 
      {
        organization,
        collaboratorsCursor,
        repositoriesCursor
      });
      
      return data;
    } catch (error) {
      if (error && error.message == ERROR_MESSAGE_ARCHIVED_REPO) {
        core.info(`⏸  Skipping archived repository ${error.data.organization.repositories.nodes[0].name}`);  
        let data = await this.requestOrganizationData(organization, null, error.data.organization.repositories.pageInfo.endCursor)        
        return data
      }
      return null;
    }
  }
  
  async startCollection() {
    if (this.enterprise) {
      const enterpriseData = await this.requestEnterpriseData();
      this.organizations = enterpriseData.organizations.nodes;
    }

    try {
      for(const { login } of this.organizations) {
        core.info(`🔍 Start collecting for organization ${login}.`);
        this.result[login] = null;
        await this.collectData(login);

        if (this.result[login]) {
          core.info(`✅ Finished collecting for organization ${login}, total number of repos: ${this.result[login].repositories.nodes.length}`);
        }
      }

      await this.endCollection();
    } catch(err) {
      console.log(err)
      await this.endCollection();
    }
  }

  async endCollection() {
    this.normalizeResult();
    const json = this.normalizedData;
    const csv = JSONtoCSV(json);

    await writeFileAsync(`${DATA_FOLDER}/${ARTIFACT_FILE_NAME}.json`, JSON.stringify(json))
    await writeFileAsync(`${DATA_FOLDER}/${ARTIFACT_FILE_NAME}.csv`, JSON.stringify(csv))

    await this.createandUploadArtifacts();
    await this.postResultsToIssue(csv)
    process.exit();
  }

  normalizeResult() {
    core.info(`Normalizing result.`);
    Object.keys(this.result).forEach(organization => {
      if (!this.result[organization] || !this.result[organization].repositories) {
        return;
      }
      this.result[organization].repositories.nodes.forEach(repository => {   
        if (!repository.collaborators.edges) {
          return;
        }     

        repository.collaborators.edges.forEach( collaborator => {
          this.normalizedData.push([
            this.enterprise,
            organization,
            repository.name,
            collaborator.node.name,
            collaborator.node.login,
            collaborator.permission 
          ])
        })        
      })
    })
  }
  
  async collectData(organization, collaboratorsCursor, repositoriesCursor) {
    const data = await this.requestOrganizationData(organization, collaboratorsCursor, repositoriesCursor);
    if(!data || !data.repositories.nodes.length) {
      core.info(`⏸  No data found for ${organization}, maybe you don't have the correct permission`);  
      return;
    }

    const repositoriesPage = data.repositories;
    const currentRepository = repositoriesPage.nodes[0];
    const collaboratorsPage = currentRepository.collaborators;
    let result = this.result[organization] ? this.result[organization] : data;

    const repositoriesInResult = result.repositories.nodes.length;
    const lastRepositoryInResult = result.repositories.nodes[repositoriesInResult - 1];
    if (result && currentRepository.name ===lastRepositoryInResult.name) {
      lastRepositoryInResult.collaborators.edges = [
        ...lastRepositoryInResult.collaborators.edges,
        ...collaboratorsPage.edges
      ]
      core.info(`⏳ Still scanning ${currentRepository.name}, current member count: ${lastRepositoryInResult.collaborators.edges.length}`);
    } else {
      core.info(`✅ Finished scanning ${lastRepositoryInResult.name}, total number of members: ${lastRepositoryInResult.collaborators.edges.length}`);
      lastRepositoryInResult.previousCursor = repositoriesCursor;
      result.repositories.nodes = [
        ...result.repositories.nodes,
        currentRepository
      ]
    };

    this.result[organization] = result;
    
    if(collaboratorsPage.pageInfo.hasNextPage === true) {
      let repoStartCursor = null;
      if (collaboratorsPage.pageInfo.hasNextPage, repositoriesInResult === 1) {
        repoStartCursor = null;
      } else {
        repoStartCursor = result.repositories.nodes[repositoriesInResult - 2 ].previousCursor;
      }
      await this.collectData(
        organization,
        collaboratorsPage.pageInfo.endCursor,
        repoStartCursor
      )
      return;
    }
      
    if(repositoriesPage.pageInfo.hasNextPage === true) {
      await this.collectData(
        organization,
        null,
        repositoriesPage.pageInfo.endCursor
      )
      return;
    }

    return this.result[organization];
  }
}

const main = async () => {
  const token = core.getInput('token') || process.env.TOKEN;
  const organization = core.getInput('organization') || process.env.ORGANIZATION;
  const enterprise = core.getInput('enterprise') || process.env.ENTERPRISE;

  const Collector = new CollectUserData(token, organization, enterprise, {
    repository: process.env.GITHUB_REPOSITORY,
    postToIssue: core.getInput('issue') || process.env.ISSUE 
  })
  await Collector.startCollection();
}

try {
  main();
} catch (error) {
  core.setFailed(error.message);
}