const NopCommand = require('../nopcommand')
const MergeDeep = require('../mergeDeep')
const ignorableFields = ['id', 'pattern']
const createBranchProtectionRule = `
mutation($vars:CreateBranchProtectionRuleInput!) {
  createBranchProtectionRule(input:$vars) {
    branchProtectionRule {
      id
    }
  }
}
`
const getBranchProtectionRule = `
query branchProtection($owner: String!, $name: String!, $cursor: String) {
  repository(owner: $owner, name: $name) {
    id
    branchProtectionRules(first: 100, after: $cursor) {
      nodes {
        id,
        pattern,
        requiresApprovingReviews,
        requiredApprovingReviewCount,
        requiresCodeOwnerReviews,
        dismissesStaleReviews,
        requiresStatusChecks,
        requiresStrictStatusChecks,
        requiredStatusCheckContexts,
        requireLastPushApproval,
        isAdminEnforced,
        allowsForcePushes,
        allowsDeletions
      }
      pageInfo {
        hasNextPage
        endCursor
      }
    }
  }
}`
const updateBranchProtectionRule = `
mutation($vars:UpdateBranchProtectionRuleInput!) {
  updateBranchProtectionRule(input:$vars) {
    branchProtectionRule {
      id
    }
  }
}
`
const deleteBranchProtectionRule = `
mutation($vars:DeleteBranchProtectionRuleInput!) {
  deleteBranchProtectionRule(input:$vars) {
    branchProtectionRule {
      id
    }
  }
}
`
module.exports = class Branches {
  constructor (nop, github, repo, settings, log) {
    this.github = github
    this.repo = repo
    this.branches = settings
    this.log = log
    this.nop = nop
  }

  sync () {
    const resArray = []
    // get the repo details
    return this.github.repos.get(this.repo).then((currentRepo) => {
      // get all the branch protection rules for the repo
      return this.getBranchProtectionRulesWithGraphQL(currentRepo).then((branchProtectionRules) => {
        return Promise.all(
          this.branches
            .filter(branch => branch.protection !== undefined)
            .map(branch => {
              let p = Object.assign(this.repo, { branch: branch.name })
              // if branch name is default, change it to the actual default name
              if (branch.name === 'default') {
                p = Object.assign(this.repo, { branch: currentRepo.data.default_branch })
                branch.name = currentRepo.data.default_branch
              }

              // If branch rule passed in safe-settings is empty
              if (this.isEmpty(branch.protection)) {
                this.log(`Deleting branch protection for branch ${branch.name}`)
                if (this.nop) {
                  resArray.push(
                    new NopCommand(this.constructor.name, this.repo, { url: deleteBranchProtectionRule }, 'Delete Branch Protection')
                  )
                  return Promise.resolve(resArray)
                }
                const branchProtectionRule = branchProtectionRules.get(branch.name)
                if (branchProtectionRule) {
                  return this.deleteBranchProtectionWithGraphQL(currentRepo, branchProtectionRule.id).then(res => this.log(`Branch protection deleted successfully ${JSON.stringify(res.url)}`)).catch(e => { this.log(`Error deleting branch protection ${JSON.stringify(e)}`); return [] })
                }
                return []
              } else {
                // Branch protection is not empty
                this.log(`Setting branch protection for branch ${branch.name}`)
                const params = Object.assign({}, p)
                const branchProtectionRule = branchProtectionRules.get(branch.name)
                if (!branchProtectionRule) {
                  // added new bp rule
                  this.log(`There is no branch ${JSON.stringify(params)}. Creating a new branch protection rule`)
                  if (this.nop) {
                    resArray.push(new NopCommand(this.constructor.name, this.repo, { url: createBranchProtectionRule }, 'add new Branch Protection'))
                    return Promise.resolve(resArray)
                  }
                  return this.createBranchProtectionWithGraphQL(currentRepo, branch).then(res => { this.log(`Branch protection applied successfully ${JSON.stringify(res)}`); return [] }).catch(e => { this.log(`Error applying branch protection ${JSON.stringify(e)}`); return [] })
                }

                const formattedProtection = this.reformatBranchProtection(branchProtectionRule)
                // verify if there are any new changes in the config
                const mergeDeep = new MergeDeep(this.log, ignorableFields)
                const changes = mergeDeep.compareDeep(formattedProtection, branch.protection)
                const results = JSON.stringify(changes, null, 2)
                this.log.debug(`Result of compareDeep for branch: ${branch.name} is ${results}`)

                if (!changes.hasChanges) {
                  this.log(`repo: ${JSON.stringify(this.repo)} There are no changes for branch ${JSON.stringify(params)}. Skipping branch protection changes`)
                  if (this.nop) {
                    return Promise.resolve(resArray)
                  }
                  return Promise.resolve()
                }

                this.log.debug(`There are changes for branch ${JSON.stringify(params)}\n ${JSON.stringify(changes)} \n Branch protection will be applied`)
                if (this.nop) {
                  resArray.push(new NopCommand(this.constructor.name, this.repo, null, `${branch.name} branch settings has ${changes.additions.length} additions and ${changes.modifications.length} modifications`))
                  resArray.push(new NopCommand(this.constructor.name, this.repo, null, `Following changes will be applied to the branch protection for ${params.branch} branch = ${results}`))
                  resArray.push(new NopCommand(this.constructor.name, this.repo, { url: updateBranchProtectionRule }, 'update Branch Protection'))
                  return Promise.resolve(resArray)
                }
                this.log.debug(`Trying to update branch protection rule with GraphQL ${JSON.stringify(params)}`)
                return this.updateBranchProtectionWithGraphQL(branchProtectionRule.id, currentRepo, branch).then(res => { this.log(`Branch protection for ${branch.name} updated successfully ${JSON.stringify(res)}`) }).catch(e => { this.log(`Error updating branch protection ${JSON.stringify(e)}`); return [] })
              }
            })
        ).then(res => {
          return res.flat(2)
        }) /* End of Promise.all */
      }).catch(e => {
        this.log.error(`error running branch protection GQL ${JSON.stringify(e)}`)
      })
    }).catch(e => {
      // Repo is not found
      if (e.status === 404) {
        return Promise.resolve([])
      }
    })
  }

  isEmpty (maybeEmpty) {
    return (maybeEmpty === null) || Object.keys(maybeEmpty).length === 0
  }

  reformatBranchProtection (protection) {
    const modifiedProtection = {}
    if (protection.requiresApprovingReviews) {
      modifiedProtection.required_pull_request_reviews = {
        required_approving_review_count: protection.requiredApprovingReviewCount,
        require_code_owner_reviews: protection.requiresCodeOwnerReviews,
        dismiss_stale_reviews: protection.dismissesStaleReviews,
        require_last_push_approval: protection.requireLastPushApproval
      }
    }

    if (protection.requiresStatusChecks) {
      modifiedProtection.required_status_checks = {
        strict: protection.requiresStrictStatusChecks,
        contexts: protection.requiredStatusCheckContexts
      }
    }

    // TODO: Github apis are returning '403: Forbidden: Resource not accessible by integration' when the push restrictions have
    // apps(like cc-atlantis). We have filed a github bug. Until that is fixed, we will not be supporting the restrictions via
    // safe-settings. https://support.github.com/ticket/enterprise/2291/1919562

    // allow restrictions only if there are any actors configured
    // if (protection.restrictsPushes && protection.pushAllowances.nodes.length > 0) {
    //   const pushAllowanceNodes = protection.pushAllowances.nodes
    //   const pushAllowanceActors = pushAllowanceNodes.map(element => element.actor.id)
    //   this.log.debug('push allowance actors' + JSON.stringify(pushAllowanceActors))
    //   modifiedProtection.restrictions = pushAllowanceActors
    // } else {
    //   modifiedProtection.restrictions = null
    // }

    modifiedProtection.enforce_admins = protection.isAdminEnforced
    modifiedProtection.allow_deletions = protection.allowsDeletions
    modifiedProtection.allow_force_pushes = protection.allowsForcePushes
    this.log.debug('reformating the branch protection rules' + JSON.stringify(protection) + ' reformatted:' + JSON.stringify(modifiedProtection))
    return modifiedProtection
  }

  reformatAndReturnBranchProtection (protection) {
    if (protection) {
      // Re-format the enabled protection attributes
      protection.required_conversation_resolution = protection.required_conversation_resolution && protection.required_conversation_resolution.enabled
      protection.allow_deletions = protection.allow_deletions && protection.allow_deletions && protection.allow_deletions.enabled
      protection.required_linear_history = protection.required_linear_history && protection.required_linear_history.enabled
      protection.enforce_admins = protection.enforce_admins && protection.enforce_admins.enabled
      protection.required_signatures = protection.required_signatures && protection.required_signatures.enabled
    }
    return protection
  }

  // function to list all branch protection rules for the given repo
  async getBranchProtectionRulesWithGraphQL (currentRepo) {
    const results = await this.fetchBranchProtectionRules(currentRepo.data.owner.login, currentRepo.data.name)
    // add those to the map
    results.forEach(element => this.log.debug(JSON.stringify(element)))
    const map = new Map(results.map(rule => [rule.pattern, rule]))
    this.log.debug('Total branchprotection rules are:' + map.size)
    return map
  }

  async fetchBranchProtectionRules (owner, name, { results, cursor } = { results: [] }) {
    const { repository: { branchProtectionRules } } = await this.github.graphql(getBranchProtectionRule, { owner, name, cursor })
    results.push(...branchProtectionRules.nodes)
    if (branchProtectionRules.pageInfo.hasNextPage) {
      await this.fetchBranchProtectionRules(owner, name, { results, cursor: branchProtectionRules.pageInfo.endCursor })
    }
    return results
  }

  // function to create a new branch protection rule.
  async createBranchProtectionWithGraphQL (currentRepo, branch) {
    const map = this.getCommonBranchProtectionInputVars(currentRepo, branch)

    // add additional vars
    map.set('repositoryId', currentRepo.data.node_id)

    const vars = {
      vars: Object.fromEntries(map)
    }
    return await this.github.graphql(createBranchProtectionRule, vars)
  }

  // helper function to create a common input variable map for the GQL branch protection inputs.
  getCommonBranchProtectionInputVars (currentRepo, branch) {
    const map = new Map()
    map.set('pattern', branch.name)

    if (branch.protection.required_pull_request_reviews) {
      map.set('requiresApprovingReviews', true)
      map.set('requiresCodeOwnerReviews', branch.protection.required_pull_request_reviews.require_code_owner_reviews ?? false)
      map.set('dismissesStaleReviews', branch.protection.required_pull_request_reviews.dismiss_stale_reviews ?? false)
      map.set('requiredApprovingReviewCount', branch.protection.required_pull_request_reviews.required_approving_review_count ?? 1)
      map.set('requireLastPushApproval', branch.protection.required_pull_request_reviews.require_last_push_approval ?? false)
    } else {
      map.set('requiresApprovingReviews', false)
    }

    if (branch.protection.required_status_checks) {
      map.set('requiresStatusChecks', true)
      map.set('requiresStrictStatusChecks', branch.protection.required_status_checks.strict ?? false)
      map.set('requiredStatusCheckContexts', branch.protection.required_status_checks.contexts)
    } else {
      map.set('requiresStatusChecks', false)
    }

    // TODO: Github apis are returning '403: Forbidden: Resource not accessible by integration' when the push restrictions have
    // apps(like cc-atlantis). We have filed a github bug. Until that is fixed, we will not be supporting the restrictions via
    // safe-settings. https://support.github.com/ticket/enterprise/2291/1919562

    // push restriction passed in the repo.yml files. Have to be actor IDS or null to disable
    // if (branch.protection.restrictions) {
    //   map.set('restrictsPushes', true)
    //   map.set('pushActorIds', branch.protection.restrictions)
    // } else {
    //   map.set('restrictsPushes', false)
    // }

    map.set('isAdminEnforced', branch.protection.enforce_admins ?? false)
    map.set('allowsForcePushes', branch.protection.allow_force_pushes ?? false)
    map.set('allowsDeletions', branch.protection.allow_deletions ?? false)
    // TODO: Introduce a new setting for bypassPullRequestActorIds to pass node_ids for the pattern based rules.
    return map
  }

  // function to update a branch protection rule.
  async updateBranchProtectionWithGraphQL (ruleId, currentRepo, branch) {
    const map = this.getCommonBranchProtectionInputVars(currentRepo, branch)
    map.set('branchProtectionRuleId', ruleId)
    const vars = {
      vars: Object.fromEntries(map)
    }
    try {
      const res = await this.github.graphql(updateBranchProtectionRule, vars)
      this.log('Updated the branch:' + JSON.stringify(branch) + ' in repo:' + JSON.stringify(currentRepo) + ' with:' + JSON.stringify(map))
      return res
    } catch (e) {
      this.log.error('Error updating the branch:' + JSON.stringify(branch) + ' in repo:' + JSON.stringify(currentRepo) + ' with:' + JSON.stringify(map))
      this.log.error(JSON.stringify(e))
      throw e
    }
  }

  // function to delete a branch protection rule.
  async deleteBranchProtectionWithGraphQL (currentRepo, ruleId) {
    const json = {
      branchProtectionRuleId: ruleId
    }
    const vars = {
      vars: json
    }
    try {
      const res = await this.github.graphql(deleteBranchProtectionRule, vars)
      this.log('Deleted the branch:' + JSON.stringify(ruleId) + ' in repo:' + JSON.stringify(currentRepo))
      return res
    } catch (e) {
      this.log.error('Error deleting ' + JSON.stringify(ruleId) + ' in repo:' + JSON.stringify(currentRepo))
      this.log.error(JSON.stringify(e))
      throw e
    }
  }
}
